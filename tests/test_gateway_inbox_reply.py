"""Phase 3 wiring — inbound Slack/Telegram replies correlate to Inbox items via the gateway.

An inbound message carrying an `[ol:<id>]` token is consumed as an Inbox reply (resolving the
item + releasing any suspended agent), not routed to the super-agent as a new turn. A normal
message still goes to the handler."""

from __future__ import annotations

from openloop.connectors import ConnectorSettings, FakeAdapter, Gateway, MessageEvent
from openloop.inbox import InboxStore
from openloop.inbox_routing import resolve_from_reply


async def test_inbound_approval_text_is_consumed_without_resolving(tmp_path):
    inbox = InboxStore(tmp_path / "inbox.json")
    item = inbox.add_approval("s1", "Restart service?", inbox="ops")

    routed: list[MessageEvent] = []

    async def handler(ev: MessageEvent) -> None:
        routed.append(ev)

    def reply_resolver(ev: MessageEvent) -> bool:
        return (
            resolve_from_reply(
                ev.text,
                inbox.resolve,
                kind_for=lambda item_id: inbox.get(item_id).kind,
            )
            is not None
        )

    settings = {"fake": ConnectorSettings("fake", enabled=True, allowed_users={"u1"})}
    gw = Gateway(settings=settings, handler=handler, reply_resolver=reply_resolver)
    fake = FakeAdapter()
    gw.register(fake)
    await gw.start()

    # Ordinary text cannot authorize an approval, and the correlated reply is not a new turn.
    await fake.inject(f"yes [ol:{item.id}]", user_id="u1")
    assert inbox.get(item.id).state == "pending"
    assert inbox.get(item.id).resolution is None
    assert routed == []

    # A normal message (no token) still goes to the handler.
    await fake.inject("hey, what's up?", user_id="u1")
    assert len(routed) == 1 and routed[0].text == "hey, what's up?"

    await gw.stop()


async def test_freetext_answer_to_question_is_consumed(tmp_path):
    inbox = InboxStore(tmp_path / "inbox.json")
    q = inbox.add_question("s1", "Which region?", inbox="ops")
    routed: list = []

    async def handler(ev):
        routed.append(ev)

    settings = {"fake": ConnectorSettings("fake", enabled=True, allow_all=True)}
    gw = Gateway(
        settings=settings,
        handler=handler,
        reply_resolver=lambda ev: (
            resolve_from_reply(
                ev.text,
                inbox.resolve,
                kind_for=lambda item_id: inbox.get(item_id).kind,
            )
            is not None
        ),
    )
    fake = FakeAdapter()
    gw.register(fake)
    await gw.start()

    await fake.inject(f"us-west-2 [ol:{q.id}]", user_id="anyone")
    assert inbox.get(q.id).resolution == "us-west-2"
    assert routed == []
    await gw.stop()
