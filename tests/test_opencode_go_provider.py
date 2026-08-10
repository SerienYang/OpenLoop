from __future__ import annotations

from typing import Any, Optional

import pytest

from openloop.providers.base import (
    AssistantTurn,
    ModelCapabilities,
    ProviderClient,
    StreamChunk,
)
from openloop.providers.opencode_go import (
    CHAT_BASE_URL,
    CHAT_MODELS,
    MESSAGES_BASE_URL,
    MESSAGES_MODELS,
    RESPONSES_MODELS,
    OpenCodeGoProvider,
)


EXPECTED_CHAT_MODELS = {
    "grok-4.5",
    "glm-5.2",
    "glm-5.1",
    "kimi-k3",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "hy3",
}
EXPECTED_RESPONSES_MODELS = {"gpt-5.6-luna"}
EXPECTED_MESSAGES_MODELS = {
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "qwen3.8-max",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
}


class _Delegate(ProviderClient):
    def __init__(self, name: str):
        self.name = name
        self.complete_models: list[str] = []
        self.stream_models: list[str] = []

    def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None,
        **settings: Any,
    ) -> AssistantTurn:
        self.complete_models.append(model)
        return AssistantTurn(text=self.name)

    def stream(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None,
        **settings: Any,
    ):
        self.stream_models.append(model)
        yield StreamChunk(turn=AssistantTurn(text=self.name))

    def capabilities(self, model: str) -> ModelCapabilities:
        return ModelCapabilities()


def _provider() -> tuple[OpenCodeGoProvider, _Delegate, _Delegate, _Delegate]:
    chat = _Delegate("chat")
    responses = _Delegate("responses")
    messages = _Delegate("messages")
    provider = OpenCodeGoProvider(
        api_key="go-key",
        chat_client=chat,
        responses_client=responses,
        messages_client=messages,
    )
    return provider, chat, responses, messages


def test_official_protocol_sets_are_complete_and_disjoint():
    assert CHAT_MODELS == EXPECTED_CHAT_MODELS
    assert RESPONSES_MODELS == EXPECTED_RESPONSES_MODELS
    assert MESSAGES_MODELS == EXPECTED_MESSAGES_MODELS
    all_models = CHAT_MODELS | RESPONSES_MODELS | MESSAGES_MODELS
    assert len(all_models) == 19
    assert not (CHAT_MODELS & RESPONSES_MODELS)
    assert not (CHAT_MODELS & MESSAGES_MODELS)
    assert not (RESPONSES_MODELS & MESSAGES_MODELS)


def test_real_delegates_use_fixed_bases_and_basic_compatibility():
    from openloop.providers import (
        AnthropicProvider,
        OpenAIProvider,
        OpenAIResponsesProvider,
    )

    provider = OpenCodeGoProvider(api_key="go-key")
    chat = provider._client_for("deepseek-v4-flash")
    responses = provider._client_for("gpt-5.6-luna")
    messages = provider._client_for("qwen3.8-max")

    assert isinstance(chat, OpenAIProvider)
    assert chat._api_key == "go-key" and chat._base_url == CHAT_BASE_URL
    assert isinstance(responses, OpenAIResponsesProvider)
    assert responses._api_key == "go-key" and responses._base_url == CHAT_BASE_URL
    assert responses._compatibility_mode is True
    assert isinstance(messages, AnthropicProvider)
    assert messages._api_key == "go-key" and messages._base_url == MESSAGES_BASE_URL
    assert messages._compatibility_mode is True and messages.thinking_budget == 0


@pytest.mark.parametrize(
    ("models", "delegate_name"),
    [
        (EXPECTED_CHAT_MODELS, "chat"),
        (EXPECTED_RESPONSES_MODELS, "responses"),
        (EXPECTED_MESSAGES_MODELS, "messages"),
    ],
)
def test_complete_routes_every_official_model(models: set[str], delegate_name: str):
    for model in models:
        provider, chat, responses, messages = _provider()
        turn = provider.complete(model=model, messages=[{"role": "user", "content": "hi"}])
        assert turn.text == delegate_name
        calls = {
            "chat": chat.complete_models,
            "responses": responses.complete_models,
            "messages": messages.complete_models,
        }
        assert calls[delegate_name] == [model]
        assert sum(len(value) for value in calls.values()) == 1


@pytest.mark.parametrize(
    ("models", "delegate_name"),
    [
        (EXPECTED_CHAT_MODELS, "chat"),
        (EXPECTED_RESPONSES_MODELS, "responses"),
        (EXPECTED_MESSAGES_MODELS, "messages"),
    ],
)
def test_stream_routes_every_official_model(models: set[str], delegate_name: str):
    for model in models:
        provider, chat, responses, messages = _provider()
        chunks = list(
            provider.stream(model=model, messages=[{"role": "user", "content": "hi"}])
        )
        assert chunks[-1].turn.text == delegate_name
        calls = {
            "chat": chat.stream_models,
            "responses": responses.stream_models,
            "messages": messages.stream_models,
        }
        assert calls[delegate_name] == [model]
        assert sum(len(value) for value in calls.values()) == 1


@pytest.mark.parametrize("method", ["complete", "stream"])
def test_unknown_model_fails_before_any_delegate_call(method: str):
    provider, chat, responses, messages = _provider()
    with pytest.raises(ValueError, match="Unsupported OpenCode Go model"):
        result = getattr(provider, method)(
            model="future-model",
            messages=[{"role": "user", "content": "hi"}],
        )
        if method == "stream":
            list(result)
    assert not chat.complete_models and not chat.stream_models
    assert not responses.complete_models and not responses.stream_models
    assert not messages.complete_models and not messages.stream_models
