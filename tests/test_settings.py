"""Tests for the model API-key settings path (Tauri desktop Phase 2).

A Tauri-launched sidecar doesn't inherit the shell env, so the key may live only in the
SecretStore. These cover: the env→store resolver, the status shape (never leaks the key),
and the REST round-trip. No network, no model calls.
"""

from __future__ import annotations

from pathlib import Path

from openloop.providers import resolve_api_key
from openloop.secrets import SecretStore


def test_resolve_api_key_prefers_env(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env-123")
    secrets = SecretStore(path=tmp_path / "secrets.json")
    secrets.put("provider:openai", {"type": "api_key", "api_key": "sk-store-999"})
    assert resolve_api_key(secrets) == "sk-env-123"


def test_resolve_api_key_falls_back_to_store(monkeypatch, tmp_path):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    secrets = SecretStore(path=tmp_path / "secrets.json")
    assert resolve_api_key(secrets) is None
    secrets.put("provider:openai", {"type": "api_key", "api_key": "sk-store-999"})
    assert resolve_api_key(secrets) == "sk-store-999"


def test_settings_rest_roundtrip(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from openloop.server.app import create_app
    from openloop.server.manager import SessionManager

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "state"))
    manager = SessionManager(data_dir=tmp_path / "data")
    client = TestClient(create_app(manager))

    before = client.get("/v1/settings").json()
    assert (
        before["has_key"] is False
        and before["source"] is None
        and before["provider"] == "openai"
    )
    assert before["onboarded"] is False and before["model"] in before["models"]

    set_resp = client.post(
        "/v1/settings/model-key", json={"api_key": "sk-secret-xyz"}
    ).json()
    assert (
        set_resp["ok"] is True
        and set_resp["has_key"] is True
        and set_resp["source"] == "store"
    )

    after = client.get("/v1/settings").json()
    assert after["has_key"] is True
    # the key value is never returned by either endpoint
    assert "sk-secret-xyz" not in str(set_resp) and "api_key" not in after

    # empty key is rejected
    assert (
        client.post("/v1/settings/model-key", json={"api_key": "  "}).json()["ok"]
        is False
    )


def test_default_model_and_onboarding_persist(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from openloop.server.app import create_app
    from openloop.server.manager import SessionManager

    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "state"))
    data_dir = tmp_path / "data"
    client = TestClient(create_app(SessionManager(data_dir=data_dir)))

    # set a default model + mark onboarded
    assert (
        client.post("/v1/settings/default-model", json={"model": "gpt-4o"}).json()[
            "model"
        ]
        == "gpt-4o"
    )
    assert (
        client.post("/v1/settings/onboarded", json={"value": True}).json()["onboarded"]
        is True
    )
    assert (
        client.post("/v1/settings/default-model", json={"model": " "}).json()["ok"]
        is False
    )

    # a fresh manager over the same data dir restores both from prefs.json
    reborn = SessionManager(data_dir=data_dir)
    assert reborn.model == "gpt-4o"
    s = reborn.get_settings()
    assert s["onboarded"] is True and s["model"] == "gpt-4o"


def test_nav_layout_setting_roundtrips(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from openloop.server.app import create_app
    from openloop.server.manager import SessionManager

    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "state"))
    data_dir = tmp_path / "data"
    client = TestClient(create_app(SessionManager(data_dir=data_dir)))

    # defaults to "flat"
    assert client.get("/v1/settings").json()["nav_layout"] == "flat"

    resp = client.post("/v1/settings/nav-layout", json={"nav_layout": "grouped"}).json()
    assert resp == {"ok": True, "nav_layout": "grouped"}
    assert client.get("/v1/settings").json()["nav_layout"] == "grouped"

    # unknown value falls back to flat; persists across a restart
    assert (
        client.post("/v1/settings/nav-layout", json={"nav_layout": "bogus"}).json()[
            "nav_layout"
        ]
        == "flat"
    )
    client.post("/v1/settings/nav-layout", json={"nav_layout": "grouped"})
    reborn = SessionManager(data_dir=data_dir)
    assert reborn.get_settings()["nav_layout"] == "grouped"


def test_session_root_setting_persists_and_drives_provisioning(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from openloop.server.app import create_app
    from openloop.server.manager import SessionManager

    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "state"))
    data_dir = tmp_path / "data"
    client = TestClient(create_app(SessionManager(data_dir=data_dir)))

    # defaults to ~/OpenLoop
    before = client.get("/v1/settings").json()
    assert before["session_root"] == "~/OpenLoop"
    assert "scratch_base" not in before

    base = tmp_path / "my openloop files"
    resp = client.post("/v1/settings/session-root", json={"path": str(base)}).json()
    assert resp["ok"] is True and resp["session_root"] == str(base)
    assert "scratch_base" not in resp
    assert base.is_dir()  # created on set
    assert (
        client.post("/v1/settings/session-root", json={"path": " "}).json()["ok"]
        is False
    )

    # persists across a restart and actually drives where scratch dirs are provisioned
    reborn = SessionManager(data_dir=data_dir)
    assert reborn.get_settings()["session_root"] == str(base)
    scratch = reborn._provision_scratch("sess-xyz")
    # Session dirs are date-prefixed `<YYYY-MM-DD>_<session_id>`.
    import time

    expected = base / f"{time.strftime('%Y-%m-%d')}_sess-xyz"
    assert Path(scratch) == expected.resolve() and Path(scratch).is_dir()


def test_provision_uses_iso_date_and_underscore(tmp_path, monkeypatch):
    import os
    import re

    from openloop.server.manager import SessionManager

    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "state"))
    mgr = SessionManager(data_dir=tmp_path / "data")
    mgr.set_session_root(str(tmp_path / "root"))

    ws = mgr._provision_scratch("10f75855-0c7a-4d93-91f8-acde00000001")
    name = os.path.basename(ws)

    assert re.fullmatch(
        r"\d{4}-\d{2}-\d{2}_10f75855-0c7a-4d93-91f8-acde00000001",
        name,
    )


def test_auto_provisioned_workspace_is_marked_managed(tmp_path, monkeypatch):
    from openloop.server.manager import SessionManager

    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "state"))
    mgr = SessionManager(data_dir=tmp_path / "data")
    root = tmp_path / "root"
    mgr.set_session_root(str(root))

    sid = "managed-meta"
    engine = mgr.get_engine(sid, agent="openloop")
    assert engine is not None
    mgr.save(sid, engine)

    rec = mgr.session_store.load(sid)
    assert rec is not None
    assert rec.workspace_kind == "managed"
    assert rec.managed_root == str(root)


def test_scratch_base_pref_migrates_to_session_root(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path))
    (tmp_path / "prefs.json").write_text('{"scratch_base": "~/LegacyDir"}')

    from openloop.server.manager import SessionManager

    mgr = SessionManager()

    assert str(mgr.session_root()).endswith("LegacyDir")
    assert "scratch_base" not in mgr._prefs


def test_validate_root_reports_writability(tmp_path, monkeypatch):
    from openloop.server.manager import SessionManager

    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "state"))
    mgr = SessionManager(data_dir=tmp_path / "data")

    ok = mgr.validate_root(str(tmp_path / "new_root"))
    assert ok["ok"] is True
    assert ok["writable"] is True

    file_path = tmp_path / "not-a-dir"
    file_path.write_text("x", encoding="utf-8")
    bad = mgr.validate_root(str(file_path))
    assert bad["ok"] is False


def test_session_root_routes_roundtrip_and_alias(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from openloop.server.app import create_app
    from openloop.server.manager import SessionManager

    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "state"))
    client = TestClient(create_app(SessionManager(data_dir=tmp_path / "data")))

    root = tmp_path / "session-root"
    resp = client.post("/v1/settings/session-root", json={"path": str(root)}).json()
    assert resp["ok"] is True
    assert resp["session_root"] == str(root)
    assert "scratch_base" not in resp

    alias = tmp_path / "alias-root"
    alias_resp = client.post("/v1/settings/scratch-base", json={"path": str(alias)}).json()
    assert alias_resp["ok"] is True
    assert alias_resp["session_root"] == str(alias)
    assert "scratch_base" not in alias_resp

    validate = client.post("/v1/settings/validate-folder", json={"path": str(root)}).json()
    assert validate["ok"] is True
    assert validate["writable"] is True


def test_ollama_models_gated_on_liveness(tmp_path, monkeypatch):
    """`ollama:*` entries show only while a local Ollama answers — keyless must not mean
    always-present (a stray ollama:<junk> pref would otherwise render forever)."""
    from openloop.server.manager import SessionManager

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "state"))
    manager = SessionManager(data_dir=tmp_path / "data")
    manager.add_model("ollama:llama3.3")

    monkeypatch.setattr(SessionManager, "_ollama_alive", lambda self: False)
    assert "ollama:llama3.3" not in manager.get_settings()["models"]

    monkeypatch.setattr(SessionManager, "_ollama_alive", lambda self: True)
    assert "ollama:llama3.3" in manager.get_settings()["models"]
