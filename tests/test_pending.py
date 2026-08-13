from __future__ import annotations

import asyncio
import json

import pytest

from openloop.pending import (
    KIND_APPROVAL,
    STATE_RESOLVED,
    PendingStore,
    pending_approver,
)


def test_add_and_filter(tmp_path):
    store = PendingStore(tmp_path / "pending.json")
    store.add_approval("s1", "Run shell?")
    store.add_question("s1", "Which env?")
    assert len(store.list(session_id="s1")) == 2
    assert len(store.pending("s1")) == 2


def test_notifications_are_not_pending_items(tmp_path):
    import openloop.pending as pending

    assert not hasattr(pending, "KIND_NOTIFICATION")
    assert not hasattr(PendingStore(tmp_path / "pending.json"), "add_notification")
    with pytest.raises(ValueError):
        PendingStore(tmp_path / "pending.json").add("s1", "notification", "FYI")


def test_legacy_inbox_file_migrates_without_notifications(tmp_path):
    from openloop.inbox import InboxStore

    legacy = InboxStore(tmp_path / "inbox.json")
    keep = legacy.add_approval("s1", "Run shell?")
    legacy.add_notification("s1", "FYI")

    store = PendingStore(tmp_path / "pending.json", legacy_path=tmp_path / "inbox.json")
    assert store.get(keep.id) is not None
    assert [item.kind for item in store.list()] == [KIND_APPROVAL]
    assert (tmp_path / "pending.json").is_file()


def test_resolve_is_idempotent_first_responder_wins(tmp_path):
    store = PendingStore(tmp_path / "pending.json")
    item = store.add_approval("s1", "Run shell?")
    assert store.resolve(item.id, "allow") is True
    assert store.resolve(item.id, "deny") is False
    got = store.get(item.id)
    assert got.state == STATE_RESOLVED and got.resolution == "allow"


def test_persistence(tmp_path):
    store = PendingStore(tmp_path / "pending.json")
    item = store.add_approval("s1", "Run shell?")
    store.resolve(item.id, "allow")
    reloaded = PendingStore(tmp_path / "pending.json")
    assert reloaded.get(item.id).resolution == "allow"


def test_resolve_question_is_idempotent_and_binds_response_to_payload(tmp_path):
    store = PendingStore(tmp_path / "pending.json")
    item = store.add_question("s1", "Attach the reference")
    content = [{"type": "text", "text": "Use this"}]

    accepted = store.resolve_question(
        item.id,
        expected_session_id="s1",
        response_id="response-1",
        resolution="Use this",
        answer_content=content,
    )
    replay = store.resolve_question(
        item.id,
        expected_session_id="s1",
        response_id="response-1",
        resolution="Use this",
        answer_content=content,
    )
    conflict = store.resolve_question(
        item.id,
        expected_session_id="s1",
        response_id="response-1",
        resolution="Changed",
        answer_content=[{"type": "text", "text": "Changed"}],
    )

    assert accepted.status == "accepted"
    assert replay.status == "accepted_replay"
    assert conflict.status == "response_conflict"
    reloaded = PendingStore(tmp_path / "pending.json")
    saved = reloaded.get(item.id)
    assert saved.state == STATE_RESOLVED
    assert saved.data["answer_content"] == content
    assert saved.data["response_id"] == "response-1"
    assert saved.data["response_digest"].startswith("sha256:")


def test_resolve_question_rejects_wrong_session_and_non_question(tmp_path):
    store = PendingStore(tmp_path / "pending.json")
    question = store.add_question("s1", "Question")
    approval = store.add_approval("s1", "Approval")

    wrong_session = store.resolve_question(
        question.id,
        expected_session_id="other",
        response_id="r1",
        resolution="answer",
        answer_content="answer",
    )
    wrong_kind = store.resolve_question(
        approval.id,
        expected_session_id="s1",
        response_id="r2",
        resolution="allow",
        answer_content="allow",
    )

    assert wrong_session.status == "rejected"
    assert wrong_kind.status == "rejected"
    assert store.get(question.id).state != STATE_RESOLVED
    assert store.get(approval.id).state != STATE_RESOLVED


def test_resolve_question_accepts_attachment_only_answer(tmp_path):
    store = PendingStore(tmp_path / "pending.json")
    item = store.add_question("s1", "Show me")
    content = [
        {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,AA=="},
        }
    ]

    result = store.resolve_question(
        item.id,
        expected_session_id="s1",
        response_id="image-response",
        resolution="[1 image]",
        answer_content=content,
    )

    assert result.status == "accepted"
    assert store.question_answer(item.id)["content"] == content


def test_resolve_question_save_failure_does_not_publish_or_wake(tmp_path, monkeypatch):
    store = PendingStore(tmp_path / "pending.json")
    item = store.add_question("s1", "Question")

    def fail_save(_items):
        raise OSError("disk full")

    monkeypatch.setattr(store._store, "_save_items", fail_save)
    with pytest.raises(OSError, match="disk full"):
        store.resolve_question(
            item.id,
            expected_session_id="s1",
            response_id="r1",
            resolution="answer",
            answer_content="answer",
        )

    assert store.get(item.id).state != STATE_RESOLVED
    assert item.id not in store._waiters


def test_consuming_question_answer_removes_duplicate_attachment_payload(tmp_path):
    store = PendingStore(tmp_path / "pending.json")
    item = store.add_question("s1", "Question")
    content = [
        {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,AA=="},
        }
    ]
    result = store.resolve_question(
        item.id,
        expected_session_id="s1",
        response_id="r1",
        resolution="[1 image]",
        answer_content=content,
        answer_display={
            "text": "",
            "attachments": [
                {
                    "kind": "image",
                    "name": "image.png",
                    "data_url": "data:image/png;base64,AA==",
                }
            ],
        },
    )

    assert store.mark_question_answer_consumed(
        item.id,
        response_id="r1",
        response_digest=result.item.data["response_digest"],
    )
    saved = store.get(item.id)
    assert "answer_content" not in saved.data
    assert "answer_display" not in saved.data


def test_grouped_question_answer_cleanup_is_all_or_nothing(tmp_path):
    store = PendingStore(tmp_path / "pending.json")
    first = store.add_question("s1", "First")
    second = store.add_question("s1", "Second")
    results = [
        store.resolve_question(
            item.id,
            expected_session_id="s1",
            response_id=f"response-{index}",
            resolution=answer,
            answer_content=answer,
        )
        for index, (item, answer) in enumerate(
            ((first, "one"), (second, "two")), start=1
        )
    ]
    entries = [
        {
            "item_id": result.item.id,
            "response_id": result.item.data["response_id"],
            "response_digest": result.item.data["response_digest"],
        }
        for result in results
    ]
    conflicting = [dict(entries[0]), {**entries[1], "response_digest": "sha256:bad"}]

    assert store.mark_question_answers_consumed(conflicting) is False
    assert "answer_content" in store.get(first.id).data
    assert "answer_content" in store.get(second.id).data

    assert store.mark_question_answers_consumed(entries) is True
    assert "answer_content" not in store.get(first.id).data
    assert "answer_content" not in store.get(second.id).data


def test_question_options_are_normalized_and_deduplicated(tmp_path):
    store = PendingStore(tmp_path / "pending.json")
    item = store.add_question(
        "s1",
        "How should this be handled?",
        options=[
            "  Keep local  ",
            {"value": "abort_push", "label": "  Stop before pushing  "},
            {"value": "different-hidden-value", "label": "Stop before pushing"},
        ],
    )

    assert item.options == ["Keep local", "Stop before pushing"]
    reloaded = PendingStore(tmp_path / "pending.json")
    assert reloaded.get(item.id).options == item.options


def test_question_options_reject_non_lists_and_normalize_existing_disk_data(tmp_path):
    path = tmp_path / "pending.json"
    store = PendingStore(path)
    rejected = store.add_question(
        "s1",
        "Broken shape",
        options={"value": "x", "label": "X"},
    )
    assert rejected.options == []
    assert store.add_question("s2", "Tuple", options=("A", "B")).options == []
    assert store.add_question("s3", "Partial", options=["A", 42]).options == []

    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["items"][0]["options"] = [
        {"value": "hidden", "label": "  Visible answer  "},
        {"value": "other", "label": "Visible answer"},
        {"value": "", "label": "Empty"},
        42,
    ]
    raw_text = json.dumps(raw)
    path.write_text(raw_text, encoding="utf-8")

    reloaded = PendingStore(path)
    assert reloaded.get(rejected.id).options == []
    assert path.read_text(encoding="utf-8") == raw_text


def test_reconcile_on_resume(tmp_path):
    store = PendingStore(tmp_path / "pending.json")
    answered = store.add_approval("s1", "Deploy?")
    store.resolve(answered.id, "allow")
    store.add_question("s1", "Still pending?")
    store.add_approval("other", "Not mine")
    out = store.reconcile_on_resume("s1")
    assert [i["title"] for i in out["pending"]] == ["Still pending?"]
    assert [i["title"] for i in out["recap"]] == ["Deploy?"]


def test_pending_approver_allow(tmp_path):
    async def run():
        store = PendingStore(tmp_path / "pending.json")
        from openloop.engine import ApprovalOutcome, PermissionRequest

        approver = pending_approver(store, "s1")
        req = PermissionRequest("run_shell", {}, None, "needs approval")

        async def resolve_soon():
            for _ in range(200):
                pend = store.pending("s1")
                if pend:
                    store.resolve(pend[0].id, "allow")
                    return
                await asyncio.sleep(0.001)

        outcome, _ = await asyncio.gather(approver(req), resolve_soon())
        assert outcome is ApprovalOutcome.ONCE
        assert store.list(session_id="s1")[0].kind == KIND_APPROVAL

    asyncio.run(run())


def test_pending_approver_deny(tmp_path):
    async def run():
        store = PendingStore(tmp_path / "pending.json")
        from openloop.engine import ApprovalOutcome, PermissionRequest

        approver = pending_approver(store, "s1")
        req = PermissionRequest("rm", {}, None, "danger")

        async def resolve_soon():
            for _ in range(200):
                pend = store.pending("s1")
                if pend:
                    store.resolve(pend[0].id, "deny")
                    return
                await asyncio.sleep(0.001)

        outcome, _ = await asyncio.gather(approver(req), resolve_soon())
        assert outcome is ApprovalOutcome.DENY

    asyncio.run(run())


def test_args_preview():
    from openloop.pending import args_preview

    assert (
        args_preview({"path": "g.txt", "content": "buy milk"})
        == "path: g.txt · content: buy milk"
    )
    assert args_preview(None) == "" and args_preview({}) == ""
    assert "\n" not in args_preview({"x": "a\nb\nc"})
    assert args_preview({"content": "z" * 300}).endswith("…")
