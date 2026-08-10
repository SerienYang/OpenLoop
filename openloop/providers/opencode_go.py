"""OpenCode Go provider with exact per-model protocol routing."""

from __future__ import annotations

from typing import Any, Optional

from .anthropic_provider import AnthropicProvider
from .base import AssistantTurn, ModelCapabilities, ProviderClient
from .capabilities import capabilities_for
from .openai_provider import OpenAIProvider
from .openai_responses import OpenAIResponsesProvider

CHAT_BASE_URL = "https://opencode.ai/zen/go/v1"
MESSAGES_BASE_URL = "https://opencode.ai/zen/go"

CHAT_MODELS = {
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
RESPONSES_MODELS = {"gpt-5.6-luna"}
MESSAGES_MODELS = {
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "qwen3.8-max",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
}


class OpenCodeGoProvider(ProviderClient):
    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        chat_client: Optional[ProviderClient] = None,
        responses_client: Optional[ProviderClient] = None,
        messages_client: Optional[ProviderClient] = None,
    ) -> None:
        self._api_key = api_key
        self._chat_client = chat_client
        self._responses_client = responses_client
        self._messages_client = messages_client

    def _require_key(self) -> str:
        if not self._api_key:
            raise RuntimeError(
                "No OpenCode Go API key configured. Add your key in Settings."
            )
        return self._api_key

    def _client_for(self, model: str) -> ProviderClient:
        if model in CHAT_MODELS:
            if self._chat_client is None:
                self._chat_client = OpenAIProvider(
                    api_key=self._require_key(),
                    base_url=CHAT_BASE_URL,
                    default_model=model,
                )
            return self._chat_client
        if model in RESPONSES_MODELS:
            if self._responses_client is None:
                self._responses_client = OpenAIResponsesProvider(
                    api_key=self._require_key(),
                    base_url=CHAT_BASE_URL,
                    compatibility_mode=True,
                    default_model=model,
                )
            return self._responses_client
        if model in MESSAGES_MODELS:
            if self._messages_client is None:
                self._messages_client = AnthropicProvider(
                    api_key=self._require_key(),
                    base_url=MESSAGES_BASE_URL,
                    compatibility_mode=True,
                    thinking_budget=0,
                    default_model=model,
                )
            return self._messages_client
        raise ValueError(
            f"Unsupported OpenCode Go model: {model}. "
            "Update OpenLoop to refresh the supported model list."
        )

    def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None,
        **settings: Any,
    ) -> AssistantTurn:
        return self._client_for(model).complete(
            model=model,
            messages=messages,
            tools=tools,
            **settings,
        )

    def stream(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None,
        **settings: Any,
    ):
        yield from self._client_for(model).stream(
            model=model,
            messages=messages,
            tools=tools,
            **settings,
        )

    def capabilities(self, model: str) -> ModelCapabilities:
        return capabilities_for(f"opencode-go:{model}")
