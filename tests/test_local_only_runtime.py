from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from openloop.connectors.descriptors import get_descriptor
from openloop.connectors.setup import (
    connect_connector,
    connector_list,
    disconnect_connector,
)
from openloop.mcp.config import put_global_server, read_global
from openloop.secrets import SecretStore
from openloop.server.app import create_app
from openloop.server.manager import SessionManager


DELETED_MODULES = (
    "openloop.cloud",
    "openloop.connectors.relay_client",
    "openloop.connectors.github_relay",
    "openloop.connectors.github_installs",
)

MANUAL_CONNECTORS = (
    "telegram",
    "slack",
    "email",
    "gmail",
    "google_calendar",
    "github",
    "outlook",
    "jira",
    "confluence",
    "zendesk",
    "linear",
    "gitlab",
    "discord",
    "stripe",
    "asana",
    "hubspot",
    "dropbox",
    "box",
    "whatsapp",
    "quickbooks",
    "docusign",
    "clickup",
    "google_drive",
    "canva",
    "figma",
    "close",
    "notion",
    "attio",
    "posthog",
    "mixpanel",
    "amplitude",
    "apollo",
    "hunter",
)

UNAVAILABLE_CONNECTORS = ("datadog", "salesforce", "descript", "clay", "pagerduty")


def _manual_fields(name: str) -> dict[str, str]:
    descriptor = get_descriptor(name)
    assert descriptor is not None
    values = {
        "address": "user@example.com",
        "email": "user@example.com",
        "base_url": "https://example.test",
        "subdomain": "example",
        "account_id": "account-1",
        "project_id": "project-1",
        "phone_number_id": "123456",
        "imap_port": "993",
        "smtp_port": "587",
    }
    return {
        field.key: values.get(field.key, f"test-{field.key}")
        for field in descriptor.fields
        if field.required and field.key != "allowed_users"
    }


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    manager = SessionManager(workspace=tmp_path)
    return TestClient(create_app(manager))


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/v1/cloud/status"),
        ("POST", "/v1/cloud/login"),
        ("POST", "/v1/cloud/logout"),
        ("POST", "/v1/cloud/telemetry"),
        ("GET", "/v1/cloud/gallery"),
        ("POST", "/v1/connectors/slack/connect-managed"),
        ("GET", "/auth/callback"),
        ("POST", "/oauth/callback"),
    ],
)
def test_cloud_routes_do_not_exist(client: TestClient, method: str, path: str) -> None:
    assert client.request(method, path).status_code == 404


def test_persona_install_route_is_absent(client: TestClient) -> None:
    assert client.post(
        "/v1/personas/install", json={"gallery_slug": "sales"}
    ).status_code == 404


def test_cloud_and_relay_modules_are_absent() -> None:
    root = Path(__file__).resolve().parents[1]
    for module in DELETED_MODULES:
        assert not (root / (module.replace(".", "/") + ".py")).exists()


@pytest.mark.parametrize("name", MANUAL_CONNECTORS)
def test_manual_connector_survives_restart_and_disconnects(
    name: str, tmp_path: Path
) -> None:
    path = tmp_path / "secrets.json"
    first = SecretStore(path)
    assert connect_connector(first, name, _manual_fields(name), validate=False)["ok"]

    restarted = SecretStore(path)
    row = {item["name"]: item for item in connector_list(restarted)}[name]
    assert row["connected"] is True
    assert disconnect_connector(restarted, name)["ok"]

    final = SecretStore(path)
    assert {item["name"]: item for item in connector_list(final)}[name][
        "connected"
    ] is False


def test_browser_remains_credential_free(tmp_path: Path) -> None:
    rows = {item["name"]: item for item in connector_list(SecretStore(tmp_path / "s"))}
    assert rows["browser"]["connected"] is True


@pytest.mark.parametrize("name", UNAVAILABLE_CONNECTORS)
def test_unavailable_connectors_stay_unavailable(name: str, tmp_path: Path) -> None:
    secrets = SecretStore(tmp_path / "secrets.json")
    row = {item["name"]: item for item in connector_list(secrets)}[name]
    assert row["available"] is False
    assert connect_connector(secrets, name, {}, validate=False)["ok"] is False


def test_expired_manual_oauth_requires_replacement_without_broker(
    tmp_path: Path,
) -> None:
    secrets = SecretStore(tmp_path / "secrets.json")
    assert connect_connector(
        secrets, "gmail", {"access_token": "expired"}, validate=False
    )["ok"]
    profile = secrets.get("gmail:account:manual")
    assert profile is not None
    profile["expires"] = time.time() - 60
    secrets.put("gmail:account:manual", profile)

    row = {item["name"]: item for item in connector_list(secrets)}["gmail"]
    assert row["accounts"] == [
        {
            "email": "manual",
            "default": True,
            "scopes": "",
            "needs_reauth": True,
        }
    ]


@pytest.mark.parametrize("name", ["jira", "monday"])
def test_local_mcp_tokens_survive_restart_and_disconnect(
    name: str, tmp_path: Path, monkeypatch
) -> None:
    state = tmp_path / "state"
    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(state))
    path = state / "secrets.json"
    first = SecretStore(path)
    first.put(f"{name}:default", {"mode": "mcp", "enabled": True})
    first.put(
        f"mcp-oauth:{name}",
        {
            "tokens": {"access_token": "at", "refresh_token": "rt"},
            "client_info": {
                "client_id": "dcr-client",
                "redirect_uris": ["http://127.0.0.1:8765/mcp/oauth/callback"],
            },
        },
    )
    descriptor = get_descriptor(name)
    assert descriptor is not None and descriptor.mcp_url
    put_global_server(
        name,
        {"url": descriptor.mcp_url, "auth": "oauth", "enabled": True},
    )

    restarted = SecretStore(path)
    row = {item["name"]: item for item in connector_list(restarted)}[name]
    assert row["connected"] is True and row["mode"] == "mcp"
    assert restarted.get(f"mcp-oauth:{name}")["client_info"]["client_id"] == "dcr-client"

    assert disconnect_connector(restarted, name)["ok"]
    assert restarted.get(f"mcp-oauth:{name}") is None
    assert name not in read_global()
