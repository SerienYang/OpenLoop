"""Interactive prompts over messaging: button encoding, block rendering, and the click→resolve path."""

import asyncio
import json

from openloop.pending import PendingStore
from openloop.interactions import Button, buttons_for, decode, encode
from openloop.connectors.base import InteractionEvent
from openloop.connectors.senders import _slack_blocks
from openloop.providers import ModelCapabilities, ProviderClient
from openloop.server.manager import SessionManager


class ScriptedProvider(ProviderClient):
    def __init__(self, turns):
        self._turns = list(turns)

    def complete(self, *, model, messages, tools=None, **settings):
        return self._turns.pop(0)

    def capabilities(self, model):
        return ModelCapabilities()


def test_encode_decode_roundtrip():
    v = encode("abc123", "allow")
    assert decode(v) == ("abc123", "allow")
    assert decode("not json") is None
    assert decode(json.dumps({"nope": 1})) is None


def test_buttons_for_kinds(tmp_path):
    st = PendingStore(tmp_path / "pending.json")
    appr = st.add_approval("s1", "Run `write_file`?")
    btns = buttons_for(appr)
    assert [b.label for b in btns] == ["Approve", "Deny"]
    assert decode(btns[0].value) == (appr.id, "allow")
    assert decode(btns[1].value) == (appr.id, "deny")

    q = st.add_question("s1", "Which region?", options=["us-east-1", "us-west-2"])
    qb = buttons_for(q)
    assert [b.label for b in qb] == ["us-east-1", "us-west-2"]
    assert decode(qb[0].value) == (q.id, "us-east-1")  # resolution IS the option text

    # free-text questions and directory prompts get no buttons → "open the app"
    assert buttons_for(st.add_question("s1", "Say something")) == []
    assert buttons_for(st.add_directory("s1", "Grant access?")) == []


def test_structured_question_options_use_visible_labels_as_resolutions(tmp_path):
    st = PendingStore(tmp_path / "pending.json")
    question = st.add_question(
        "s1",
        "How should this be handled?",
        options=[
            {"value": "keep_as_local", "label": "Keep as a local change"},
            {"value": "abort_push", "label": "Stop before pushing"},
        ],
    )

    buttons = buttons_for(question)

    assert [button.label for button in buttons] == [
        "Keep as a local change",
        "Stop before pushing",
    ]
    assert [decode(button.value) for button in buttons] == [
        (question.id, "Keep as a local change"),
        (question.id, "Stop before pushing"),
    ]


def test_multi_and_malformed_question_options_do_not_create_message_buttons(tmp_path):
    st = PendingStore(tmp_path / "pending.json")
    multi = st.add_question(
        "s1",
        "Choose several",
        options=["A", "B"],
        multi=True,
    )
    assert buttons_for(multi) == []

    malformed = st.add_question("s2", "Broken", options=[42, {"value": "x"}])
    assert buttons_for(malformed) == []


def test_slack_blocks_shape():
    blocks = _slack_blocks("Run `x`?", [Button("Approve", "v1"), Button("Deny", "v2")])
    assert blocks[0]["type"] == "section"
    els = blocks[1]["elements"]
    assert [e["text"]["text"] for e in els] == ["Approve", "Deny"]
    assert [e["value"] for e in els] == ["v1", "v2"]
    assert [e["action_id"] for e in els] == ["openloop_0", "openloop_1"]
    # no buttons → just the section, no actions block
    assert len(_slack_blocks("hi", [])) == 1


def test_interaction_click_resolves_item(tmp_path):
    mgr = SessionManager(workspace=tmp_path, provider=ScriptedProvider([]))
    mgr.secrets.put(
        "slack:default",
        {
            "bot_token": "xoxb-test",
            "app_token": "xapp-test",
            "allowed_users": ["U_BOB"],
            "approval_owner_ids": ["U_BOB"],
        },
    )
    item = mgr.inbox.add_approval("sX", "Run `write_file`?")

    resolved: list = []

    async def fake_wait(item_id):
        # stand in for the suspended agent: record what the item resolved to
        ev = mgr.inbox._waiters.setdefault(item_id, asyncio.Event())
        await ev.wait()
        resolved.append(mgr.inbox.get(item_id).resolution)

    async def scenario():
        waiter = asyncio.create_task(fake_wait(item.id))
        await asyncio.sleep(0)  # let the waiter register
        await mgr._on_interaction(
            InteractionEvent(
                platform="slack",
                chat_id="C1",
                message_id="111.2",
                value=encode(item.id, "allow"),
                user_id="U_BOB",
                user_name="bob",
            )
        )
        await asyncio.wait_for(waiter, timeout=2)

    asyncio.run(scenario())
    assert resolved == ["allow"]
    assert mgr.inbox.get(item.id).state == "resolved"
