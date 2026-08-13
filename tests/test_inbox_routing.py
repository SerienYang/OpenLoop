"""Phase 3 gate — multi-inbox routing: named bindings, route resolution, delivery + reply."""

from __future__ import annotations

import asyncio
import json

import pytest

from openloop.inbox import InboxStore
from openloop.inbox_routing import (
    DEFAULT_INBOX,
    InboxRouting,
    deliver,
    resolve_from_reply,
)


def test_route_precedence(tmp_path):
    r = InboxRouting(tmp_path / "routing.json")
    r.set_binding("ops", channel="slack", target="#ops-openloop")
    r.set_session_override("s1", "ops")
    assert r.route_for("s1") == "ops"
    r.set_session_override("s1", DEFAULT_INBOX)
    assert r.route_for("s1") == DEFAULT_INBOX
    assert r.route_for("s2") == DEFAULT_INBOX
    assert not hasattr(r, "set_persona_default")
    assert "persona_default" not in json.loads(r.path.read_text())


def test_bindings_persist(tmp_path):
    InboxRouting(tmp_path / "routing.json").set_binding(
        "ops", channel="telegram", target="123"
    )
    r2 = InboxRouting(tmp_path / "routing.json")
    b = r2.binding_for("ops")
    assert b.channel == "telegram" and b.target == "123"


def test_deliver_to_channel_embeds_item_id(tmp_path):
    store = InboxStore(tmp_path / "inbox.json")
    routing = InboxRouting(tmp_path / "routing.json")
    routing.set_binding("ops", channel="slack", target="#ops")
    item = store.add_approval("s1", "Restart service?", body="prod web-1", inbox="ops")

    sent = {}

    def sender(channel, target, text):
        sent.update(channel=channel, target=target, text=text)

    assert deliver(item, routing.binding_for("ops"), sender) is True
    assert sent["channel"] == "slack" and sent["target"] == "#ops"
    assert f"[ol:{item.id}]" in sent["text"]  # rebrand: emits [ol:…] since 2026-07-22


def test_in_app_only_binding_delivers_nothing(tmp_path):
    store = InboxStore(tmp_path / "inbox.json")
    routing = InboxRouting(tmp_path / "routing.json")
    item = store.add_approval("s1", "x", inbox=DEFAULT_INBOX)
    calls = []
    assert (
        deliver(item, routing.binding_for(DEFAULT_INBOX), lambda *a: calls.append(a))
        is False
    )
    assert calls == []


@pytest.mark.parametrize(
    "answer",
    ["yes", "no", "allow", "deny", "approve", "always", "👍", "❌"],
)
def test_approval_text_reply_never_resolves_pending_item(tmp_path, answer):
    store = InboxStore(tmp_path / "inbox.json")
    item = store.add_approval("s1", "Deploy?", inbox="ops")
    waiter = store._waiters.setdefault(item.id, asyncio.Event())

    result = resolve_from_reply(
        f"{answer} [ol:{item.id}]",
        store.resolve,
        kind_for=lambda item_id: store.get(item_id).kind,
    )

    assert result is False
    assert store.get(item.id).state == "pending"
    assert store.get(item.id).resolution is None
    assert waiter.is_set() is False


@pytest.mark.parametrize("answer", ["yes", "no", "allow", "deny"])
def test_same_text_replies_still_resolve_questions(tmp_path, answer):
    store = InboxStore(tmp_path / "inbox.json")
    q = store.add_question("s1", "Which region?")
    res = resolve_from_reply(
        f"{answer} [ol:{q.id}]",
        store.resolve,
        kind_for=lambda item_id: store.get(item_id).kind,
    )
    assert res is True and store.get(q.id).resolution == answer


def test_reply_without_token_is_ignored(tmp_path):
    store = InboxStore(tmp_path / "inbox.json")
    assert resolve_from_reply("random chatter", store.resolve) is None


def test_legacy_inbox_tokens_are_ignored(tmp_path):
    store = InboxStore(tmp_path / "inbox.json")
    item = store.add_approval("s1", "Deploy?", inbox="ops")
    assert resolve_from_reply(f"deny [ocw:{item.id}]", store.resolve) is None
    assert store.get(item.id).state == "pending"


def test_words_containing_no_are_not_parsed_as_deny(tmp_path):
    store = InboxStore(tmp_path / "inbox.json")
    q = store.add_question("s1", "Which region?")
    assert (
        resolve_from_reply(
            f"north-east node [ol:{q.id}]",
            store.resolve,
            kind_for=lambda item_id: store.get(item_id).kind,
        )
        is True
    )
    assert store.get(q.id).resolution == "north-east node"
