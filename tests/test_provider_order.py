from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json

import pytest

from openloop.provider_order import (
    MAX_APPLIED_REQUESTS,
    MAX_SAFE_INTEGER,
    applied_request_state,
    default_provider_order,
    normalize_applied_requests,
    normalize_provider_order,
    promote_provider,
    record_applied_request,
    validate_provider_ids,
    validate_revision,
)


def test_normalize_provider_order_deduplicates_drops_stale_and_appends_known():
    assert normalize_provider_order(
        ["openai", "openai", "stale"],
        known=["anthropic", "openai", "opencode-go"],
        built_in=["anthropic", "openai", "opencode-go"],
    ) == ["openai", "anthropic", "opencode-go"]


def test_normalize_provider_order_ignores_malformed_stored_values():
    assert normalize_provider_order(
        [None, "", 7, "openai"],
        known=["anthropic", "openai"],
        built_in=["anthropic", "openai"],
    ) == ["openai", "anthropic"]
    assert normalize_provider_order(
        "not-a-list",
        known=["anthropic", "openai"],
        built_in=["anthropic", "openai"],
    ) == ["anthropic", "openai"]


def test_default_order_puts_configured_first_and_preserves_built_in_order():
    assert default_provider_order(
        built_in=["anthropic", "openai", "opencode-go", "ollama"],
        configured={"opencode-go", "openai"},
    ) == ["openai", "opencode-go", "anthropic", "ollama"]


def test_promote_provider_moves_only_the_target():
    assert promote_provider(
        ["anthropic", "openai", "opencode-go", "ollama"], "opencode-go"
    ) == ["opencode-go", "anthropic", "openai", "ollama"]
    assert promote_provider(["opencode-go", "anthropic"], "opencode-go") == [
        "opencode-go",
        "anthropic",
    ]


@pytest.mark.parametrize("value", [0, 1, MAX_SAFE_INTEGER])
def test_validate_revision_accepts_javascript_safe_non_negative_integer(value):
    assert validate_revision(value) == value


@pytest.mark.parametrize(
    "value",
    [None, True, False, -1, 1.5, "1", MAX_SAFE_INTEGER + 1],
)
def test_validate_revision_rejects_unsafe_values(value):
    with pytest.raises(ValueError, match="revision"):
        validate_revision(value)


@pytest.mark.parametrize(
    "value",
    [None, [], "openai", ["openai", ""], ["openai", 3], [True]],
)
def test_validate_provider_ids_rejects_invalid_payload(value):
    with pytest.raises(ValueError, match="providers"):
        validate_provider_ids(value)


def test_validate_provider_ids_keeps_partial_duplicate_and_stale_strings():
    assert validate_provider_ids(["openai", "openai", "stale"]) == [
        "openai",
        "openai",
        "stale",
    ]


def test_applied_request_ring_is_normalized_and_bounded():
    requests = [
        {"request_id": f"00000000-0000-4000-8000-{index:012d}", "revision": index}
        for index in range(MAX_APPLIED_REQUESTS + 5)
    ]
    normalized = normalize_applied_requests(requests)
    assert len(normalized) == MAX_APPLIED_REQUESTS
    assert normalized[0]["revision"] == 5
    assert normalized[-1]["revision"] == MAX_APPLIED_REQUESTS + 4


def test_record_applied_request_is_idempotent():
    request_id = "00000000-0000-4000-8000-000000000001"
    once = record_applied_request([], request_id, 2)
    twice = record_applied_request(once, request_id, 3)
    assert twice == once


def test_applied_request_state_is_true_false_unknown_or_none():
    request_id = "00000000-0000-4000-8000-000000000001"
    applied = [{"request_id": request_id, "revision": 4}]
    assert applied_request_state(applied, None, current_revision=4, base_revision=None) is None
    assert (
        applied_request_state(applied, request_id, current_revision=4, base_revision=3)
        is True
    )
    assert (
        applied_request_state(
            applied,
            "00000000-0000-4000-8000-000000000002",
            current_revision=4,
            base_revision=4,
        )
        is False
    )
    assert (
        applied_request_state(
            applied,
            "00000000-0000-4000-8000-000000000002",
            current_revision=5,
            base_revision=4,
        )
        == "unknown"
    )


def _manager(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "state"))
    from openloop.server.manager import SessionManager

    return SessionManager(data_dir=tmp_path / "data")


def test_prefs_save_is_atomic_and_preserves_old_json_on_replace_failure(
    tmp_path, monkeypatch
):
    manager = _manager(tmp_path, monkeypatch)
    manager.set_nav_layout("grouped")
    before = manager._prefs_path().read_text(encoding="utf-8")
    assert json.loads(before)["nav_layout"] == "grouped"

    real_replace = __import__("os").replace

    def fail_prefs_replace(source, target):
        if str(target) == str(manager._prefs_path()):
            raise OSError("replace failed")
        return real_replace(source, target)

    monkeypatch.setattr("os.replace", fail_prefs_replace)
    with pytest.raises(OSError, match="replace failed"):
        manager.set_context_bar(True)

    assert manager._prefs_path().read_text(encoding="utf-8") == before
    assert json.loads(before) == json.loads(manager._prefs_path().read_text())


def test_preference_mutators_save_while_holding_one_shared_lock(tmp_path, monkeypatch):
    manager = _manager(tmp_path, monkeypatch)
    assert hasattr(manager, "_prefs_lock")
    seen: list[bool] = []
    original = manager._save_prefs

    def checked_save():
        seen.append(manager._prefs_lock._is_owned())
        return original()

    monkeypatch.setattr(manager, "_save_prefs", checked_save)
    manager.set_nav_layout("grouped")
    manager.set_sessions_peek(8)
    manager.set_context_bar(True)
    manager.set_onboarded(True)
    manager.set_default_model("gpt-5.5")
    manager.set_dm_session("session-1")
    manager._note_provider_use("openai")

    assert seen and all(seen)


def test_provider_order_reads_secrets_before_acquiring_preference_lock(
    tmp_path, monkeypatch
):
    manager = _manager(tmp_path, monkeypatch)
    with manager._prefs_lock:
        manager._prefs.pop("provider_order", None)
        manager._prefs.pop("provider_order_revision", None)

    preference_lock_states: list[bool] = []
    original_get = manager.secrets.get

    def checked_get(profile):
        preference_lock_states.append(manager._prefs_lock._is_owned())
        return original_get(profile)

    monkeypatch.setattr(manager.secrets, "get", checked_get)
    manager.get_provider_order()

    assert preference_lock_states
    assert not any(preference_lock_states)


def test_concurrent_timestamp_and_order_writes_preserve_both_changes(
    tmp_path, monkeypatch
):
    manager = _manager(tmp_path, monkeypatch)
    before = manager.get_provider_order()

    with ThreadPoolExecutor(max_workers=2) as executor:
        timestamp = executor.submit(manager._note_provider_use, "openai")
        reorder = executor.submit(
            manager.set_provider_order,
            list(reversed(before["providers"])),
            before["revision"],
            "00000000-0000-4000-8000-000000000009",
        )
        timestamp.result()
        saved = reorder.result()

    persisted = json.loads(manager._prefs_path().read_text(encoding="utf-8"))
    assert persisted["provider_last_used"]["openai"] > 0
    assert persisted["provider_order"] == saved["providers"]
    assert persisted["provider_order_revision"] == saved["revision"]


def test_manager_initializes_configured_first_order_and_persists_revision(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "state"))
    from openloop.secrets import SecretStore
    from openloop.server.manager import SessionManager

    secrets = SecretStore(path=tmp_path / "state" / "secrets.json")
    secrets.put("provider:deepseek", {"api_key": "ds-key"})
    manager = SessionManager(data_dir=tmp_path / "data")
    state = manager.get_provider_order()
    assert state["revision"] == 1
    assert state["providers"][0] == "deepseek"

    reborn = SessionManager(data_dir=tmp_path / "data")
    assert reborn.get_provider_order() == state


def test_legacy_provider_order_without_valid_revision_migrates_to_revision_one(
    tmp_path, monkeypatch
):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "prefs.json").write_text(
        json.dumps(
            {
                "provider_order": ["openai"],
                "provider_order_revision": "7",
            }
        ),
        encoding="utf-8",
    )

    manager = _manager(tmp_path, monkeypatch)
    state = manager.get_provider_order()

    assert state["providers"][0] == "openai"
    assert state["revision"] == 1
    assert json.loads((data_dir / "prefs.json").read_text())[
        "provider_order_revision"
    ] == 1


def test_provider_order_normalization_increments_valid_revision_once(
    tmp_path, monkeypatch
):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "prefs.json").write_text(
        json.dumps(
            {
                "provider_order": ["openai", "openai", "stale"],
                "provider_order_revision": 7,
            }
        ),
        encoding="utf-8",
    )

    manager = _manager(tmp_path, monkeypatch)
    state = manager.get_provider_order()
    reborn = _manager(tmp_path, monkeypatch)

    assert state["providers"][0] == "openai"
    assert "stale" not in state["providers"]
    assert state["revision"] == 8
    assert reborn.get_provider_order()["revision"] == 8


def test_manual_order_normalizes_persists_and_is_idempotent(tmp_path, monkeypatch):
    manager = _manager(tmp_path, monkeypatch)
    before = manager.get_provider_order()
    request_id = "00000000-0000-4000-8000-000000000010"
    result = manager.set_provider_order(
        ["openai", "openai", "stale"],
        before["revision"],
        request_id,
    )
    assert result["ok"] is True
    assert result["providers"][0] == "openai"
    assert len(result["providers"]) == len(set(result["providers"]))
    assert "stale" not in result["providers"]
    assert result["revision"] == before["revision"] + 1

    duplicate = manager.set_provider_order(
        list(reversed(result["providers"])),
        before["revision"],
        request_id,
    )
    assert duplicate["request_applied"] is True
    assert duplicate["providers"] == result["providers"]
    assert duplicate["revision"] == result["revision"]

    reborn = _manager(tmp_path, monkeypatch)
    assert reborn.get_provider_order()["providers"] == result["providers"]
    assert reborn.get_provider_order()["revision"] == result["revision"]
    assert [provider["name"] for provider in reborn.get_providers()] == result[
        "providers"
    ]


def test_manual_order_reports_conflict_with_canonical_state(tmp_path, monkeypatch):
    manager = _manager(tmp_path, monkeypatch)
    state = manager.get_provider_order()
    conflict = manager.set_provider_order(
        list(reversed(state["providers"])),
        state["revision"] + 1,
        "00000000-0000-4000-8000-000000000011",
    )
    assert conflict == {
        "ok": False,
        "conflict": True,
        "providers": state["providers"],
        "revision": state["revision"],
    }


def test_order_reconciliation_is_true_false_unknown_or_null(tmp_path, monkeypatch):
    manager = _manager(tmp_path, monkeypatch)
    before = manager.get_provider_order()
    request_id = "00000000-0000-4000-8000-000000000012"
    after = manager.set_provider_order(
        list(reversed(before["providers"])),
        before["revision"],
        request_id,
    )
    assert (
        manager.get_provider_order(request_id, before["revision"])["request_applied"]
        is True
    )
    assert (
        manager.get_provider_order(
            "00000000-0000-4000-8000-000000000013",
            after["revision"],
        )["request_applied"]
        is False
    )
    assert (
        manager.get_provider_order(
            "00000000-0000-4000-8000-000000000013",
            before["revision"],
        )["request_applied"]
        == "unknown"
    )
    assert manager.get_provider_order()["request_applied"] is None


def test_provider_order_rest_api_validates_cas_and_reconciliation(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from openloop.server.app import create_app

    manager = _manager(tmp_path, monkeypatch)
    client = TestClient(create_app(manager))
    before = client.get("/v1/providers/order").json()
    assert before["revision"] == 1

    invalid_bodies = [
        {},
        {"providers": [], "revision": 1, "request_id": "bad"},
        {"providers": ["openai", ""], "revision": 1, "request_id": "bad"},
        {"providers": ["openai", 3], "revision": 1, "request_id": "bad"},
        {
            "providers": ["openai"],
            "revision": True,
            "request_id": "00000000-0000-4000-8000-000000000014",
        },
        {
            "providers": ["openai"],
            "revision": 1.5,
            "request_id": "00000000-0000-4000-8000-000000000014",
        },
        {
            "providers": ["openai"],
            "revision": "1",
            "request_id": "00000000-0000-4000-8000-000000000014",
        },
    ]
    for body in invalid_bodies:
        assert client.put("/v1/providers/order", json=body).status_code == 422
    assert client.get("/v1/providers/order?request_id=bad&base_revision=1").status_code == 422
    assert (
        client.get(
            "/v1/providers/order"
            "?request_id=00000000-0000-4000-8000-000000000014"
        ).status_code
        == 422
    )

    request_id = "00000000-0000-4000-8000-000000000014"
    saved = client.put(
        "/v1/providers/order",
        json={
            "providers": ["openai"],
            "revision": before["revision"],
            "request_id": request_id,
        },
    )
    assert saved.status_code == 200
    state = saved.json()
    assert state["providers"][0] == "openai"

    conflict = client.put(
        "/v1/providers/order",
        json={
            "providers": ["anthropic"],
            "revision": before["revision"],
            "request_id": "00000000-0000-4000-8000-000000000015",
        },
    )
    assert conflict.status_code == 409
    assert conflict.json()["revision"] == state["revision"]

    reconciled = client.get(
        "/v1/providers/order",
        params={"request_id": request_id, "base_revision": before["revision"]},
    )
    assert reconciled.status_code == 200
    assert reconciled.json()["request_applied"] is True


def test_first_connection_promotes_once_removal_stays_and_reconnect_promotes(
    tmp_path, monkeypatch
):
    manager = _manager(tmp_path, monkeypatch)
    initial = manager.get_provider_order()
    assert initial["providers"][0] != "deepseek"

    connected = manager.set_provider("deepseek", {"api_key": "ds-key"})
    assert connected["provider_order"][0] == "deepseek"
    promoted_revision = connected["provider_order_revision"]

    updated = manager.set_provider("deepseek", {"api_key": "ds-key-2"})
    assert updated["provider_order"][0] == "deepseek"
    assert updated["provider_order_revision"] == promoted_revision

    manager.set_provider_order(
        ["openai", "deepseek"],
        promoted_revision,
        "00000000-0000-4000-8000-000000000016",
    )
    manager.remove_provider("deepseek")
    removed_order = manager.get_provider_order()
    assert removed_order["providers"][0] == "openai"

    reconnected = manager.set_provider("deepseek", {"api_key": "ds-key-3"})
    assert reconnected["provider_order"][0] == "deepseek"
    assert reconnected["provider_order"][1:] == removed_order["providers"][
        : removed_order["providers"].index("deepseek")
    ] + removed_order["providers"][removed_order["providers"].index("deepseek") + 1 :]


def test_first_connection_journal_never_contains_the_key_and_is_removed(
    tmp_path, monkeypatch
):
    manager = _manager(tmp_path, monkeypatch)
    original_put = manager.secrets.put

    def inspect_then_put(profile, data):
        journal = manager._provider_config_journal_path()
        assert journal.is_file()
        assert "super-secret-key" not in journal.read_text(encoding="utf-8")
        original_put(profile, data)

    monkeypatch.setattr(manager.secrets, "put", inspect_then_put)
    result = manager.set_provider("deepseek", {"api_key": "super-secret-key"})
    assert result["ok"] is True
    assert not manager._provider_config_journal_path().exists()


def test_first_connection_journal_write_failure_does_not_write_secret_or_order(
    tmp_path, monkeypatch
):
    manager = _manager(tmp_path, monkeypatch)
    before = manager.get_provider_order()

    def fail_journal(**_kwargs):
        raise OSError("journal failed")

    monkeypatch.setattr(manager, "_write_provider_config_journal", fail_journal)
    result = manager.set_provider("deepseek", {"api_key": "ds-key"})

    assert result["ok"] is False
    assert manager.secrets.get_raw("provider:deepseek") is None
    assert manager.get_provider_order()["providers"] == before["providers"]
    assert manager.get_provider_order()["revision"] == before["revision"]
    assert not manager._provider_config_journal_path().exists()


def test_first_connection_secret_write_failure_restores_order_and_removes_journal(
    tmp_path, monkeypatch
):
    manager = _manager(tmp_path, monkeypatch)
    before = manager.get_provider_order()

    def fail_secret_write(_profile, _data):
        raise OSError("secret failed")

    monkeypatch.setattr(manager.secrets, "put", fail_secret_write)
    result = manager.set_provider("deepseek", {"api_key": "ds-key"})

    assert result["ok"] is False
    assert manager.secrets.get_raw("provider:deepseek") is None
    assert manager.get_provider_order()["providers"] == before["providers"]
    assert manager.get_provider_order()["revision"] == before["revision"]
    assert not manager._provider_config_journal_path().exists()


def test_first_connection_failure_compensates_secret_and_order(tmp_path, monkeypatch):
    manager = _manager(tmp_path, monkeypatch)
    before = manager.get_provider_order()
    original_save = manager._save_prefs
    calls = 0

    def fail_once():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("prefs failed")
        return original_save()

    monkeypatch.setattr(manager, "_save_prefs", fail_once)
    result = manager.set_provider("deepseek", {"api_key": "ds-key"})
    assert result["ok"] is False
    assert manager.secrets.get_raw("provider:deepseek") is None
    assert manager.get_provider_order()["providers"] == before["providers"]
    assert manager.get_provider_order()["revision"] == before["revision"]
    assert not manager._provider_config_journal_path().exists()


def test_secret_compensation_failure_keeps_journal_and_restart_commits_target(
    tmp_path, monkeypatch
):
    manager = _manager(tmp_path, monkeypatch)
    before = manager.get_provider_order()
    target = promote_provider(before["providers"], "deepseek")
    original_save = manager._save_prefs
    calls = 0

    def fail_target_save_once():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("prefs failed")
        return original_save()

    def fail_secret_compensation(_profile, _data):
        raise OSError("secret compensation failed")

    monkeypatch.setattr(manager, "_save_prefs", fail_target_save_once)
    monkeypatch.setattr(manager.secrets, "restore_raw", fail_secret_compensation)
    result = manager.set_provider("deepseek", {"api_key": "ds-key"})

    assert result["ok"] is False
    assert manager.secrets.get_raw("provider:deepseek") is not None
    assert manager._provider_config_journal_path().is_file()

    reborn = _manager(tmp_path, monkeypatch)
    recovered = reborn.get_provider_order()
    assert recovered["providers"] == target
    assert recovered["revision"] == before["revision"] + 1
    assert not reborn._provider_config_journal_path().exists()


def test_failed_compensation_keeps_journal_for_restart_recovery(tmp_path, monkeypatch):
    manager = _manager(tmp_path, monkeypatch)
    before = manager.get_provider_order()

    def always_fail():
        raise OSError("prefs failed")

    monkeypatch.setattr(manager, "_save_prefs", always_fail)
    result = manager.set_provider("deepseek", {"api_key": "ds-key"})
    assert result["ok"] is False
    assert manager.secrets.get_raw("provider:deepseek") is None
    assert manager._provider_config_journal_path().is_file()

    reborn = _manager(tmp_path, monkeypatch)
    assert reborn.get_provider_order()["providers"] == before["providers"]
    assert reborn.get_provider_order()["revision"] == before["revision"]
    assert not reborn._provider_config_journal_path().exists()


def test_restart_completes_order_when_secret_write_committed_before_crash(
    tmp_path, monkeypatch
):
    manager = _manager(tmp_path, monkeypatch)
    before = manager.get_provider_order()
    target = promote_provider(before["providers"], "deepseek")
    manager._write_provider_config_journal(
        provider="deepseek",
        previous_order=before["providers"],
        previous_revision=before["revision"],
        target_order=target,
        target_revision=before["revision"] + 1,
    )
    manager.secrets.put("provider:deepseek", {"api_key": "ds-key"})

    reborn = _manager(tmp_path, monkeypatch)
    recovered = reborn.get_provider_order()
    assert recovered["providers"] == target
    assert recovered["revision"] == before["revision"] + 1
    assert not reborn._provider_config_journal_path().exists()
