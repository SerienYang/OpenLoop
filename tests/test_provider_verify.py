"""Tests for provider key detection + the live (read-only) Test/verify path.

SDK-free: httpx calls are monkeypatched so no network is touched.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from openloop.providers import detect_provider, verify_provider_key


# -- detect_provider ------------------------------------------------------------
@pytest.mark.parametrize(
    "key,expected",
    [
        ("sk-ant-api03-abc", "anthropic"),
        ("sk-or-v1-abc", "openrouter"),
        ("AIzaSyAbc123", "gemini"),
        ("sk-proj-abc", "openai"),
        ("sk_live_abc", "openai"),
        ("", None),
        ("   ", None),
        ("nonsense", None),
    ],
)
def test_detect_provider(key, expected):
    assert detect_provider(key) == expected


# -- verify_provider_key: status-code mapping + per-provider request shape -------
def _patch_get(monkeypatch, status=200, capture=None, raise_exc=None):
    def fake_get(url, **kwargs):
        if capture is not None:
            capture["url"] = url
            capture.update(kwargs)
        if raise_exc is not None:
            raise raise_exc
        return SimpleNamespace(status_code=status)

    monkeypatch.setattr("httpx.get", fake_get)


def _patch_post(monkeypatch, status=200, capture=None, raise_exc=None, payload=None):
    def fake_post(url, **kwargs):
        if capture is not None:
            capture["url"] = url
            capture.update(kwargs)
        if raise_exc is not None:
            raise raise_exc
        return SimpleNamespace(status_code=status, json=lambda: payload or {})

    monkeypatch.setattr("httpx.post", fake_post)


def test_verify_openai_ok(monkeypatch):
    cap: dict = {}
    _patch_get(monkeypatch, status=200, capture=cap)
    assert verify_provider_key("openai", api_key="sk-x") == {"ok": True}
    assert cap["url"] == "https://api.openai.com/v1/models"
    assert cap["headers"]["Authorization"] == "Bearer sk-x"


def test_verify_openai_custom_endpoint(monkeypatch):
    cap: dict = {}
    _patch_get(monkeypatch, status=200, capture=cap)
    verify_provider_key(
        "openai", api_key="sk-x", base_url="https://gw.example/openai/v1/"
    )
    # trailing slash trimmed, /models appended to the custom endpoint
    assert cap["url"] == "https://gw.example/openai/v1/models"


def test_verify_bad_key_is_invalid(monkeypatch):
    _patch_get(monkeypatch, status=401)
    assert verify_provider_key("openai", api_key="sk-bad") == {
        "ok": False,
        "error": "Invalid API key.",
    }


def test_verify_anthropic_headers(monkeypatch):
    cap: dict = {}
    _patch_get(monkeypatch, status=200, capture=cap)
    verify_provider_key("anthropic", api_key="sk-ant-x")
    assert cap["url"] == "https://api.anthropic.com/v1/models"
    assert cap["headers"]["x-api-key"] == "sk-ant-x"
    assert "anthropic-version" in cap["headers"]


def test_verify_gemini_key_param(monkeypatch):
    cap: dict = {}
    _patch_get(monkeypatch, status=200, capture=cap)
    verify_provider_key("gemini", api_key="AIza-x")
    assert cap["params"]["key"] == "AIza-x"


def test_verify_ollama_uses_v1_models_no_key(monkeypatch):
    cap: dict = {}
    _patch_get(monkeypatch, status=200, capture=cap)
    verify_provider_key("ollama", base_url="http://localhost:11434")
    assert cap["url"] == "http://localhost:11434/v1/models"
    assert "headers" not in cap  # keyless


def test_verify_opencode_go_uses_fixed_models_endpoint_and_bearer_key(monkeypatch):
    cap: dict = {}
    _patch_get(monkeypatch, status=200, capture=cap)
    assert verify_provider_key("opencode-go", api_key="go-key") == {"ok": True}
    assert cap["url"] == "https://opencode.ai/zen/go/v1/models"
    assert cap["headers"] == {"Authorization": "Bearer go-key"}


@pytest.mark.parametrize("status", [401, 403])
def test_verify_opencode_go_rejects_invalid_key(monkeypatch, status):
    _patch_get(monkeypatch, status=status)
    assert verify_provider_key("opencode-go", api_key="bad") == {
        "ok": False,
        "error": "Invalid API key.",
    }


def test_verify_volcengine_uses_agent_plan_chat_probe(monkeypatch):
    cap: dict = {}
    _patch_post(monkeypatch, status=200, capture=cap)

    assert verify_provider_key(
        "volcengine",
        api_key="ark-plan-key",
        base_url="https://ark.cn-beijing.volces.com/api/plan/v3/",
    ) == {"ok": True}
    assert (
        cap["url"]
        == "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions"
    )
    assert cap["headers"]["Authorization"] == "Bearer ark-plan-key"
    assert cap["headers"]["Content-Type"] == "application/json"
    assert cap["json"]["model"] == "ark-code-latest"
    assert cap["json"]["messages"] == [{"role": "user", "content": "ping"}]
    assert cap["json"]["max_tokens"] == 1
    assert cap["timeout"] == 10.0


@pytest.mark.parametrize(
    ("status", "payload", "error"),
    [
        (
            401,
            {"error": {"code": "AuthenticationError"}},
            "Volcengine rejected the API key. Use the dedicated Agent Plan API key.",
        ),
        (
            401,
            {"error": {"code": "InvalidAccountStatus"}},
            "Volcengine rejected the account status. Contact the platform administrator.",
        ),
        (
            400,
            {"error": {"code": "InvalidSubscription"}},
            "Volcengine Agent Plan subscription is inactive or expired.",
        ),
        (
            403,
            {"error": {"code": "AccountOverdueError"}},
            "Volcengine denied the request. Check Agent Plan access, account balance, and resource permissions.",
        ),
        (
            404,
            {"error": {"code": "ModelNotOpen"}},
            "Volcengine could not access the requested model or endpoint. Check model availability and the Endpoint setting.",
        ),
    ],
)
def test_verify_volcengine_reports_actionable_failures(
    monkeypatch, status, payload, error
):
    _patch_post(monkeypatch, status=status, payload=payload)

    assert verify_provider_key(
        "volcengine",
        api_key="ark-plan-key",
        base_url="https://ark.cn-beijing.volces.com/api/plan/v3",
    ) == {"ok": False, "error": error}


def test_verify_volcengine_reports_unexpected_status(monkeypatch):
    _patch_post(monkeypatch, status=500, payload={"error": {"code": "InternalError"}})

    assert verify_provider_key("volcengine", api_key="ark-plan-key") == {
        "ok": False,
        "error": "Volcengine Ark (Agent Plan) returned HTTP 500.",
    }


def test_verify_volcengine_reports_network_error(monkeypatch):
    _patch_post(monkeypatch, raise_exc=ConnectionError("boom"))

    res = verify_provider_key("volcengine", api_key="ark-plan-key")
    assert res["ok"] is False
    assert res["error"] == "Couldn't reach Volcengine Ark (Agent Plan) (ConnectionError)."


def test_verify_network_error_is_clean(monkeypatch):
    _patch_get(monkeypatch, raise_exc=ConnectionError("boom"))
    res = verify_provider_key("openai", api_key="sk-x")
    assert res["ok"] is False
    assert "Couldn't reach" in res["error"]


def test_verify_unexpected_status(monkeypatch):
    _patch_get(monkeypatch, status=500)
    res = verify_provider_key("anthropic", api_key="sk-ant-x")
    assert res["ok"] is False
    assert "500" in res["error"]
