from __future__ import annotations

import asyncio

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
