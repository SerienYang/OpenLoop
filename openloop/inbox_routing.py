"""Multi-inbox routing — named inboxes + delivery bindings.

An inbox is a named queue with optional delivery binding(s): in-app is always the store of
record; a binding can also mirror items to a Slack channel or Telegram chat. Sessions route to
an inbox by a per-session override, otherwise ``"default"``. Bindings are bidirectional: an
item is delivered to the bound channel with its id embedded, and an inbound reply correlated
by that id resolves the item.
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Optional

DEFAULT_INBOX = "default"
# Embeds the item id in an OpenLoop-delivered message.
_ID_TOKEN = re.compile(r"\[ol:([0-9a-f]{6,})\]")
# Whole words only — substring matching resolved "disallow" as allow and "note" as deny.
_ALLOW_WORDS = re.compile(r"\b(?:approve|approved|allow|allowed|yes)\b")
_DENY_WORDS = re.compile(r"\b(?:deny|denied|reject|rejected|no)\b")


@dataclass
class InboxBinding:
    name: str
    channel: Optional[str] = None  # None (in-app only) | "slack" | "telegram"
    target: str = ""  # channel id / chat id for the binding


class InboxRouting:
    def __init__(self, path: Optional[str | Path] = None) -> None:
        self.path = Path(path) if path else None
        self._lock = threading.Lock()
        self._bindings: dict[str, InboxBinding] = {
            DEFAULT_INBOX: InboxBinding(DEFAULT_INBOX)
        }
        self._session_override: dict[str, str] = {}
        self._load()

    def _load(self) -> None:
        if self.path and self.path.is_file():
            data = json.loads(self.path.read_text(encoding="utf-8"))
            for raw in data.get("bindings", []):
                b = InboxBinding(**raw)
                self._bindings[b.name] = b
            self._session_override = dict(data.get("session_override", {}))

    def _save(self) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(
                {
                    "bindings": [asdict(b) for b in self._bindings.values()],
                    "session_override": self._session_override,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    # -- config -----------------------------------------------------------------
    def set_binding(
        self, name: str, *, channel: Optional[str] = None, target: str = ""
    ) -> None:
        with self._lock:
            self._bindings[name] = InboxBinding(name, channel, target)
            self._save()

    def binding_for(self, name: str) -> InboxBinding:
        return self._bindings.get(name) or InboxBinding(name)

    def set_session_override(self, session_id: str, inbox_name: str) -> None:
        with self._lock:
            self._session_override[session_id] = inbox_name
            self._save()

    # -- resolution -------------------------------------------------------------
    def route_for(self, session_id: str) -> str:
        """Resolve a session override, falling back to the global default inbox."""
        return self._session_override.get(session_id, DEFAULT_INBOX)

    def bindings(self) -> list[dict]:
        return [asdict(b) for b in self._bindings.values()]


# -- delivery + inbound correlation ---------------------------------------------
Sender = Callable[[str, str, str], None]  # (channel, target, text) -> None


def deliver(item, binding: InboxBinding, sender: Optional[Sender]) -> bool:
    """Mirror an inbox item to its bound channel (if any). The item id is embedded so an inbound
    reply can be correlated back. In-app-only bindings deliver nothing here. Returns True if a
    channel message was sent."""
    if not binding.channel or sender is None:
        return False
    text = f"{item.title}\n{item.body}\n[ol:{item.id}]".strip()
    sender(binding.channel, binding.target, text)
    return True


def resolve_from_reply(
    reply: str,
    resolve: Callable[[str, str], bool],
    *,
    kind_for: Optional[Callable[[str], str]] = None,
) -> Optional[bool]:
    """Correlate an inbound channel reply to its item (by the embedded id) and resolve it.

    Looks for the ``[ol:<id>]`` token and an allow/deny intent; falls back to treating the whole
    message as a free-text answer. ``resolve(item_id, resolution)`` is the InboxStore.resolve.
    Returns the resolve() result, or None if no item id was found."""
    m = _ID_TOKEN.search(reply or "")
    if not m:
        return None
    item_id = m.group(1)
    answer = _ID_TOKEN.sub("", reply).strip()
    if kind_for is not None and kind_for(item_id) == "question":
        return resolve(item_id, answer)
    lowered = reply.lower()
    if _ALLOW_WORDS.search(lowered) or "👍" in reply or "✅" in reply:
        resolution = "allow"
    elif _DENY_WORDS.search(lowered) or "👎" in reply or "❌" in reply:
        resolution = "deny"
    else:
        resolution = answer
    return resolve(item_id, resolution)
