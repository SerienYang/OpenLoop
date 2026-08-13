"""Pending queue — actionable human decisions parked for a session."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from .inbox import (
    KIND_APPROVAL,
    KIND_DIRECTORY,
    KIND_NOTIFICATION as _KIND_NOTIFICATION,
    KIND_PLAN,
    KIND_QUESTION,
    STATE_PENDING,
    STATE_RESOLVED,
    VIS_INBOX,
    VIS_INLINE,
    InboxItem as PendingItem,
    InboxStore as _LegacyStore,
    QuestionResolutionResult,
    args_preview,
)


class PendingStore:
    def __init__(
        self,
        path: Optional[str | Path] = None,
        *,
        legacy_path: Optional[str | Path] = None,
    ) -> None:
        target = Path(path) if path else None
        legacy = Path(legacy_path) if legacy_path else None
        source = target if target and target.is_file() else legacy
        self._store = _LegacyStore(source)
        dropped_notifications = self._drop_notifications()
        if target is not None:
            self._store.path = target
            if source != target or dropped_notifications:
                self._store._save()

    def _drop_notifications(self) -> bool:
        stale = [
            item_id
            for item_id, item in self._store._items.items()
            if item.kind == _KIND_NOTIFICATION
        ]
        for item_id in stale:
            self._store._items.pop(item_id, None)
        return bool(stale)

    @property
    def _waiters(self):
        return self._store._waiters

    def add(
        self,
        session_id: str,
        kind: str,
        title: str,
        *,
        body: str = "",
        inbox: str = "default",
        visibility: str = VIS_INBOX,
        data: Optional[dict[str, Any]] = None,
        options=None,
        allow_text: bool = True,
        multi: bool = False,
        tool_call_id: Optional[str] = None,
    ) -> PendingItem:
        if kind == _KIND_NOTIFICATION:
            raise ValueError("notifications are not pending items")
        return self._store.add(
            session_id,
            kind,
            title,
            body=body,
            inbox=inbox,
            visibility=visibility,
            data=data,
            options=options,
            allow_text=allow_text,
            multi=multi,
            tool_call_id=tool_call_id,
        )

    def add_approval(self, *args, **kwargs) -> PendingItem:
        return self._store.add_approval(*args, **kwargs)

    def add_question(self, *args, **kwargs) -> PendingItem:
        return self._store.add_question(*args, **kwargs)

    def add_directory(self, *args, **kwargs) -> PendingItem:
        return self._store.add_directory(*args, **kwargs)

    def add_plan(self, *args, **kwargs) -> PendingItem:
        return self._store.add_plan(*args, **kwargs)

    def get(self, item_id: str) -> Optional[PendingItem]:
        return self._store.get(item_id)

    def list(self, **kwargs) -> list[PendingItem]:
        return self._store.list(**kwargs)

    def pending(self, session_id: Optional[str] = None) -> list[PendingItem]:
        return self._store.pending(session_id)

    def resolve(self, item_id: str, resolution: str) -> bool:
        return self._store.resolve(item_id, resolution)

    def resolve_question(self, *args, **kwargs) -> QuestionResolutionResult:
        return self._store.resolve_question(*args, **kwargs)

    def question_answer(self, item_id: str) -> Optional[dict[str, Any]]:
        return self._store.question_answer(item_id)

    def mark_question_answer_consumed(self, *args, **kwargs) -> bool:
        return self._store.mark_question_answer_consumed(*args, **kwargs)

    def mark_question_answers_consumed(self, entries: list[dict[str, str]]) -> bool:
        return self._store.mark_question_answers_consumed(entries)

    def resolve_session(self, session_id: str, resolution: str = "session deleted") -> int:
        return self._store.resolve_session(session_id, resolution)

    async def wait(self, item_id: str) -> str:
        return await self._store.wait(item_id)

    def reconcile_on_resume(self, session_id: str) -> dict:
        return self._store.reconcile_on_resume(session_id)


def pending_approver(store: PendingStore, session_id: str, *, inbox: str = "default"):
    from .engine import ApprovalOutcome, PermissionRequest

    async def approve(request: "PermissionRequest") -> "ApprovalOutcome":
        item = store.add_approval(
            session_id,
            title=f"Run `{request.tool_name}`?",
            body=request.reason or "",
            inbox=inbox,
        )
        resolution = await store.wait(item.id)
        if resolution == "always":
            return ApprovalOutcome.ALWAYS_TOOL
        if resolution == "allow":
            return ApprovalOutcome.ONCE
        return ApprovalOutcome.DENY

    return approve
