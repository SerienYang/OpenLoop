import json

from fastapi.testclient import TestClient

from openloop.providers import ModelCapabilities, ProviderClient
from openloop.server import SessionManager, create_app


class _Provider(ProviderClient):
    def complete(self, *, model, messages, tools=None, **settings):
        raise AssertionError("no model call expected")

    def capabilities(self, model):
        return ModelCapabilities()


def test_legacy_session_connector_overrides_are_removed(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "state"))
    legacy = tmp_path / "session_connections.json"
    legacy.write_text(
        json.dumps({"sessions": {"old-session": {"github": False}}}),
        encoding="utf-8",
    )

    manager = SessionManager(data_dir=tmp_path, provider=_Provider())
    manager.secrets.put("github:default", {"token": "test", "enabled": True})

    assert not legacy.exists()
    effective = manager.effective_connectors("old-session")
    assert "github" in effective
    assert effective == {
        row["name"] for row in manager.list_connectors() if row["connected"]
    }


def test_session_connection_routes_are_removed(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "state"))
    manager = SessionManager(data_dir=tmp_path, provider=_Provider())
    client = TestClient(create_app(manager))

    assert client.get("/v1/sessions/s1/connections").status_code == 404
    assert (
        client.post(
            "/v1/sessions/s1/connections",
            json={"connector": "github", "enabled": False},
        ).status_code
        == 404
    )
