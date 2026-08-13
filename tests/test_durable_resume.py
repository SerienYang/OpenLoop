"""Durable resume: a prompt pending when the process 'restarts' is answered later and the turn
continues — rebuilt from the persisted thread, with no live await."""

import asyncio

import pytest

from openloop.providers import (
    AssistantTurn,
    ModelCapabilities,
    ProviderClient,
    ToolCall,
)
from openloop.server.manager import SessionManager


class ScriptedProvider(ProviderClient):
    def __init__(self, turns):
        self._turns = list(turns)

    def complete(self, *, model, messages, tools=None, **settings):
        return self._turns.pop(0)

    def capabilities(self, model):
        return ModelCapabilities()


def _tool(name, args, call_id):
    return AssistantTurn(tool_calls=[ToolCall(id=call_id, name=name, arguments=args)])


def _text(text):
    return AssistantTurn(text=text, finish_reason="stop")


async def _run_until_pending(mgr, sid, engine):
    async def first():
        async for _ in engine.run("go"):
            pass

    task = asyncio.create_task(first())
    pend = []
    for _ in range(100):
        await asyncio.sleep(0.02)
        pend = mgr.inbox.pending(sid)
        if pend:
            break
    assert pend, "prompt never became a pending Inbox item"
    # simulate a restart: cancel the suspended turn + drop the live engine
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    mgr._engines.pop(sid, None)
    mgr.mark_idle(sid)
    return pend[0]


def _final_assistant_texts(mgr, sid):
    rec = mgr.session_store.load(sid)
    return [
        m.get("content")
        for m in rec.messages
        if m.get("role") == "assistant" and m.get("content")
    ]


def test_durable_resume_question(tmp_path):
    mgr = SessionManager(
        workspace=tmp_path,
        provider=ScriptedProvider(
            [
                _tool(
                    "ask_user",
                    {
                        "question": "Which region?",
                        "options": ["us-east-1", "us-west-2"],
                    },
                    "call_q",
                ),
                _text("You chose us-west-2."),
            ]
        ),
    )
    sid = "dur-q"

    async def scenario():
        engine = mgr.get_engine(sid, agent="openloop", workspace=str(tmp_path))
        item = await _run_until_pending(mgr, sid, engine)
        assert item.kind == "question" and item.tool_call_id == "call_q"
        await mgr.resolve_inbox(item.id, "us-west-2")  # restart-style resume
        await asyncio.gather(*list(mgr._question_resume_tasks))

    asyncio.run(scenario())
    assert any("us-west-2" in (t or "") for t in _final_assistant_texts(mgr, sid))
    assert mgr.inbox.pending(sid) == []  # nothing left pending


def test_reconcile_resumes_accepted_question_not_yet_checkpointed(tmp_path):
    mgr = SessionManager(
        workspace=tmp_path,
        provider=ScriptedProvider(
            [
                _tool("ask_user", {"question": "Which region?"}, "call_q"),
                _text("Recovered the answer."),
            ]
        ),
    )
    sid = "dur-reconcile"

    async def scenario():
        engine = mgr.get_engine(sid, agent="openloop", workspace=str(tmp_path))
        item = await _run_until_pending(mgr, sid, engine)
        result = mgr.inbox.resolve_question(
            item.id,
            expected_session_id=sid,
            response_id="response-1",
            resolution="us-west-2",
            answer_content="us-west-2",
            answer_display={"text": "us-west-2", "attachments": []},
        )
        assert result.status == "accepted"
        await mgr.reconcile_question_answers()
        await asyncio.gather(*mgr._question_resume_tasks)

    asyncio.run(scenario())
    assert any("Recovered" in (t or "") for t in _final_assistant_texts(mgr, sid))
    resolved = mgr.inbox.list(session_id=sid)[0]
    assert "answer_content" not in resolved.data
    assert resolved.data["answer_consumed_at"]


def test_question_resume_claim_failure_preserves_owner_and_reconcile_retries(tmp_path):
    mgr = SessionManager(
        workspace=tmp_path,
        provider=ScriptedProvider(
            [
                _tool("ask_user", {"question": "Which region?"}, "call_q"),
                _text("Recovered after the competing turn."),
            ]
        ),
    )
    sid = "dur-claim-owner"

    async def scenario():
        engine = mgr.get_engine(sid, agent="openloop", workspace=str(tmp_path))
        item = await _run_until_pending(mgr, sid, engine)
        result = mgr.inbox.resolve_question(
            item.id,
            expected_session_id=sid,
            response_id="response-1",
            resolution="us-west-2",
            answer_content="us-west-2",
            answer_display={"text": "us-west-2", "attachments": []},
        )
        assert result.status == "accepted"

        mgr.mark_running(sid)
        failed_resume = mgr._schedule_question_resume(item)
        if failed_resume is not None:
            await asyncio.wait_for(failed_resume, timeout=1)

        assert failed_resume is None
        assert mgr.is_running(sid) is True
        assert "answer_content" in mgr.inbox.get(item.id).data

        mgr.mark_idle(sid)
        await mgr.reconcile_question_answers()
        resume_tasks = list(mgr._question_resume_tasks)
        assert len(resume_tasks) == 1
        await asyncio.wait_for(asyncio.gather(*resume_tasks), timeout=1)

    asyncio.run(scenario())

    assert any(
        "Recovered after" in (text or "") for text in _final_assistant_texts(mgr, sid)
    )
    resolved = mgr.inbox.get(mgr.inbox.list(session_id=sid)[0].id)
    assert "answer_content" not in resolved.data
    assert resolved.data["answer_consumed_at"]


def test_reconcile_restores_deferred_answer_before_second_question(tmp_path):
    provider = ScriptedProvider(
        [
            AssistantTurn(
                tool_calls=[
                    ToolCall(
                        id="call-q1",
                        name="ask_user",
                        arguments={"question": "First?"},
                    ),
                    ToolCall(
                        id="call-q2",
                        name="ask_user",
                        arguments={"question": "Second?"},
                    ),
                ]
            ),
            _text("Recovered both answers."),
        ]
    )
    mgr = SessionManager(workspace=tmp_path, provider=provider)
    sid = "dur-two-questions"

    async def scenario():
        engine = mgr.get_engine(sid, agent="openloop", workspace=str(tmp_path))

        async def run():
            async for _ in engine.run("go"):
                pass

        task = asyncio.create_task(run())
        first = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            pending = mgr.inbox.pending(sid)
            if pending:
                first = pending[0]
                break
        assert first is not None
        mgr.inbox.resolve_question(
            first.id,
            expected_session_id=sid,
            response_id="r1",
            resolution="one",
            answer_content="one",
        )

        second = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            pending = mgr.inbox.pending(sid)
            if pending:
                second = pending[0]
                break
        assert second is not None and second.id != first.id
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        mgr._engines.pop(sid, None)
        mgr.mark_idle(sid)
        mgr.inbox.resolve_question(
            second.id,
            expected_session_id=sid,
            response_id="r2",
            resolution="two",
            answer_content="two",
        )
        await mgr.reconcile_question_answers()
        await asyncio.gather(*mgr._question_resume_tasks)

    asyncio.run(scenario())
    record = mgr.session_store.load(sid)
    answer_message = next(
        message for message in record.messages if message.get("_question_response")
    )
    assert [part["text"] for part in answer_message["content"]] == ["one", "two"]
    assert all(
        "_question_answer_deferred" not in message for message in record.messages
    )
    assert any("Recovered both" in (text or "") for text in _final_assistant_texts(mgr, sid))


def test_durable_resume_approval_executes_tool(tmp_path):
    # The model wants a write (needs approval); on durable resume "allow" must RE-EXECUTE the tool.
    target = tmp_path / "scratch_marker.txt"
    mgr = SessionManager(
        workspace=tmp_path,
        provider=ScriptedProvider(
            [
                _tool("write_file", {"path": str(target), "content": "ok"}, "call_w"),
                _text("Done — file written."),
            ]
        ),
    )
    sid = "dur-a"

    async def scenario():
        engine = mgr.get_engine(sid, agent="openloop", workspace=str(tmp_path))
        item = await _run_until_pending(mgr, sid, engine)
        assert item.kind == "approval" and item.tool_call_id == "call_w"
        assert not target.exists()  # not executed before approval
        await mgr.resolve_inbox(
            item.id, "allow"
        )  # restart-style resume → re-execute the tool

    asyncio.run(scenario())
    assert (
        target.exists() and target.read_text() == "ok"
    )  # the approved write actually ran
    assert any("Done" in (t or "") for t in _final_assistant_texts(mgr, sid))
