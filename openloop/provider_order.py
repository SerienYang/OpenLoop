"""Pure helpers for persistent model-provider ordering."""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_APPLIED_REQUESTS = 32
RequestApplied = bool | Literal["unknown"] | None


def validate_revision(value: Any) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > MAX_SAFE_INTEGER
    ):
        raise ValueError("revision must be a JavaScript-safe non-negative integer")
    return value


def validate_request_id(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("request_id must be a UUID")
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError, TypeError):
        raise ValueError("request_id must be a UUID") from None
    if str(parsed) != value.lower():
        raise ValueError("request_id must be a canonical UUID")
    return str(parsed)


def validate_provider_ids(value: Any) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ValueError("providers must be a non-empty array")
    if any(not isinstance(item, str) or not item.strip() for item in value):
        raise ValueError("providers must contain non-empty strings")
    return [item.strip() for item in value]


def normalize_provider_order(
    stored: Any,
    *,
    known: list[str],
    built_in: list[str],
) -> list[str]:
    known_set = set(known)
    order: list[str] = []
    for item in stored if isinstance(stored, list) else []:
        if isinstance(item, str) and item in known_set and item not in order:
            order.append(item)
    for item in built_in:
        if item in known_set and item not in order:
            order.append(item)
    for item in known:
        if item not in order:
            order.append(item)
    return order


def default_provider_order(
    *,
    built_in: list[str],
    configured: set[str],
) -> list[str]:
    return [
        *[name for name in built_in if name in configured],
        *[name for name in built_in if name not in configured],
    ]


def promote_provider(order: list[str], provider: str) -> list[str]:
    if provider not in order:
        return [provider, *order]
    return [provider, *[name for name in order if name != provider]]


def normalize_applied_requests(value: Any) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, dict):
            continue
        try:
            request_id = validate_request_id(item.get("request_id"))
            revision = validate_revision(item.get("revision"))
        except ValueError:
            continue
        if request_id in seen:
            continue
        seen.add(request_id)
        normalized.append({"request_id": request_id, "revision": revision})
    return normalized[-MAX_APPLIED_REQUESTS:]


def record_applied_request(
    value: Any,
    request_id: str,
    revision: int,
) -> list[dict[str, Any]]:
    request_id = validate_request_id(request_id)
    revision = validate_revision(revision)
    normalized = normalize_applied_requests(value)
    if any(item["request_id"] == request_id for item in normalized):
        return normalized
    return [
        *normalized,
        {"request_id": request_id, "revision": revision},
    ][-MAX_APPLIED_REQUESTS:]


def applied_request_state(
    applied: Any,
    request_id: str | None,
    *,
    current_revision: int,
    base_revision: int | None,
) -> RequestApplied:
    if request_id is None:
        return None
    request_id = validate_request_id(request_id)
    current_revision = validate_revision(current_revision)
    if any(
        item["request_id"] == request_id
        for item in normalize_applied_requests(applied)
    ):
        return True
    base_revision = validate_revision(base_revision)
    return False if current_revision == base_revision else "unknown"
