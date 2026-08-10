from openloop.agent import build_engine
from openloop.agents.openloop import openloop_agent
from openloop.automation import TaskStore
from openloop.providers import AssistantTurn, ModelCapabilities, ProviderClient
from openloop.secrets import SecretStore
from openloop.selfwake import WakeStore


class _StubProvider(ProviderClient):
    def complete(self, **_kwargs):
        return AssistantTurn()

    def capabilities(self, _model):
        return ModelCapabilities()


def test_unified_agent_exposes_all_tool_families(tmp_path):
    secrets = SecretStore(tmp_path / "secrets.json")
    secrets.put("telegram:default", {"bot_token": "T"})

    engine = build_engine(
        agent=openloop_agent(),
        workspace=tmp_path,
        provider=_StubProvider(),
        secrets=secrets,
        task_store=TaskStore(tmp_path / "automation.db"),
        wake_store=WakeStore(tmp_path / "wakes.json"),
        session_id="s1",
    )
    try:
        names = set(engine.registry.names())
        assert "explore" in names
        assert "create_scheduled_task" in names
        assert "sleep_for" in names
        assert "wake_on" in names
        assert "request_directory" in names
        assert "send_message" in names
    finally:
        if engine.executor is not None:
            engine.executor.close()
