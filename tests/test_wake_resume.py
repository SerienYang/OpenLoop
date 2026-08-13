"""Phase 3 wiring — self-wake tools registered, scheduler resume hook, wake messages."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from openloop.agent import build_engine
from openloop.agents import openloop_agent
from openloop.automation.scheduler import Scheduler
from openloop.events import EventType
from openloop.providers import (
    AssistantTurn,
    ModelCapabilities,
    ProviderClient,
    ToolCall,
)
from openloop.selfwake import Wake, WakeStore
from openloop.server.manager import SessionManager


class _FakeStore:
    def due(self):
        return []


class _ScriptedProvider(ProviderClient):
    def __init__(self, turns):
        self._turns = list(turns)
        self.calls = 0

    def complete(self, *, model, messages, tools=None, **settings):
        self.calls += 1
        return self._turns.pop(0)

    def capabilities(self, model):
        return ModelCapabilities()


class _FailingProvider(ProviderClient):
    def complete(self, *, model, messages, tools=None, **settings):
        raise RuntimeError("provider unavailable")

    def capabilities(self, model):
        return ModelCapabilities()


def test_scheduler_runs_extra_tick():
    async def run():
        hits = {"n": 0}

        async def extra():
            hits["n"] += 1

        sched = Scheduler(_FakeStore(), runner=None, extra_tick=extra)
        await sched._tick(trigger="schedule")
        assert hits["n"] == 1

    asyncio.run(run())


def test_wake_messages_by_kind():
    timer = Wake("1", "s1", "timer", note="poll")
    completion = Wake("2", "s1", "completion", job_id="job-9")
    event = Wake("3", "s1", "event", event_key="pr-opened")
    assert "timer" in SessionManager._wake_message(timer)
    assert "poll" in SessionManager._wake_message(timer)
    assert "job-9" in SessionManager._wake_message(completion)
    assert "pr-opened" in SessionManager._wake_message(event)


def test_selfwake_tools_registered_for_openloop(tmp_path):
    engine = build_engine(
        agent=openloop_agent(),
        workspace=tmp_path,
        wake_store=WakeStore(tmp_path / "wakes.json"),
        session_id="s1",
    )
    try:
        names = set(engine.registry.names())
        assert {"sleep_for", "wake_on", "wake_on_event"} <= names
    finally:
        engine.executor.close()


def test_selfwake_tool_suspends_turn_after_scheduling(tmp_path):
    provider = _ScriptedProvider(
        [
            AssistantTurn(
                tool_calls=[
                    ToolCall(
                        id="sleep-1",
                        name="sleep_for",
                        arguments={"seconds": 60, "note": "wait once"},
                    )
                ]
            ),
            AssistantTurn(text="continued instead of suspending"),
        ]
    )
    store = WakeStore(tmp_path / "wakes.json")
    engine = build_engine(
        agent=openloop_agent(),
        workspace=tmp_path,
        provider=provider,
        wake_store=store,
        session_id="s1",
    )

    async def run():
        return [event async for event in engine.run("start")]

    try:
        events = asyncio.run(run())
        assert provider.calls == 1
        assert events[-1].type == EventType.TURN_END
        assert events[-1].data["status"] == "suspended"
        assert len(store.pending("s1")) == 1
        tool_result = next(m for m in engine.messages if m.get("role") == "tool")
        assert "_suspend_turn" not in tool_result["content"]
    finally:
        engine.executor.close()


def test_user_steering_takes_priority_over_selfwake_suspension(tmp_path):
    provider = _ScriptedProvider(
        [
            AssistantTurn(
                tool_calls=[
                    ToolCall(
                        id="sleep-1",
                        name="sleep_for",
                        arguments={"seconds": 60},
                    )
                ]
            ),
            AssistantTurn(text="handled user steering"),
        ]
    )
    engine = build_engine(
        agent=openloop_agent(),
        workspace=tmp_path,
        provider=provider,
        wake_store=WakeStore(tmp_path / "wakes.json"),
        session_id="s1",
    )
    engine.queue_steering("user changed the task")

    async def run():
        return [event async for event in engine.run("start")]

    try:
        events = asyncio.run(run())
        assert provider.calls == 2
        assert events[-1].type == EventType.TURN_END
        assert events[-1].data["status"] == "completed"
    finally:
        engine.executor.close()


def test_durable_resume_suspends_after_replaying_selfwake(tmp_path):
    provider = _ScriptedProvider([AssistantTurn(text="continued after resume")])
    store = WakeStore(tmp_path / "wakes.json")
    engine = build_engine(
        agent=openloop_agent(),
        workspace=tmp_path,
        provider=provider,
        wake_store=store,
        session_id="s1",
        messages=[
            {"role": "user", "content": "start"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "sleep-1",
                        "type": "function",
                        "function": {
                            "name": "sleep_for",
                            "arguments": '{"seconds": 60}',
                        },
                    }
                ],
            },
        ],
    )

    async def run():
        return [event async for event in engine.resume()]

    try:
        events = asyncio.run(run())
        assert provider.calls == 0
        assert events[-1].type == EventType.TURN_END
        assert events[-1].data["status"] == "suspended"
        assert len(store.pending("s1")) == 1
    finally:
        engine.executor.close()


def test_deferred_question_answer_takes_priority_over_selfwake_suspension(tmp_path):
    provider = _ScriptedProvider([AssistantTurn(text="handled the answer")])
    store = WakeStore(tmp_path / "wakes.json")
    engine = build_engine(
        agent=openloop_agent(),
        workspace=tmp_path,
        provider=provider,
        wake_store=store,
        session_id="s1",
        messages=[
            {"role": "user", "content": "start"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "question-1",
                        "type": "function",
                        "function": {
                            "name": "ask_user",
                            "arguments": '{"question": "Continue?"}',
                        },
                    },
                    {
                        "id": "sleep-1",
                        "type": "function",
                        "function": {
                            "name": "sleep_for",
                            "arguments": '{"seconds": 60}',
                        },
                    },
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "question-1",
                "content": '{"answer": "yes"}',
                "_question_answer_deferred": {
                    "session_id": "s1",
                    "item_id": "item-1",
                    "response_id": "response-1",
                    "response_digest": "digest-1",
                    "content": "yes",
                    "display": {"text": "yes", "attachments": []},
                },
            },
        ],
    )

    async def run():
        return [event async for event in engine.resume()]

    try:
        events = asyncio.run(run())
        assert provider.calls == 1
        assert events[-1].type == EventType.TURN_END
        assert events[-1].data["status"] == "completed"
        answer = next(m for m in engine.messages if m.get("_question_response"))
        assert answer["content"] == "yes"
        assert len(store.pending("s1")) == 1
    finally:
        engine.executor.close()


def test_failed_wake_resume_stays_pending_for_retry(tmp_path):
    store = WakeStore(tmp_path / "wakes.json")
    wake = store.add_timer(
        "s1", datetime.now(timezone.utc) - timedelta(seconds=1)
    )

    class Harness:
        wakes = store

        async def _resume_wake(self, _wake):
            raise RuntimeError("temporary delivery failure")

    resumed = asyncio.run(SessionManager.resume_due_wakes(Harness()))

    assert resumed == 0
    assert [item.id for item in store.pending("s1")] == [wake.id]
    assert [item.id for item in store.due()] == [wake.id]


def test_provider_error_during_wake_stays_pending_for_retry(tmp_path):
    manager = SessionManager(workspace=tmp_path, provider=_FailingProvider())
    manager.get_engine("s1", agent="openloop")
    wake = manager.wakes.add_timer(
        "s1", datetime.now(timezone.utc) - timedelta(seconds=1)
    )

    resumed = asyncio.run(manager.resume_due_wakes())

    assert resumed == 0
    assert [item.id for item in manager.wakes.pending("s1")] == [wake.id]
    assert len(manager.unrouted.list()) == 1
