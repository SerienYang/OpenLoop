from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_legacy_agent_and_persona_sources_are_removed():
    retired = [
        ROOT / "openloop/agents/chat.py",
        ROOT / "openloop/agents/code.py",
        ROOT / "openloop/agents/myhelper.py",
        ROOT / "openloop/personas",
        ROOT / "surfaces/gui/src/components/PersonaHero.tsx",
        ROOT / "surfaces/gui/src/components/personaIcon.tsx",
        ROOT / "surfaces/gui/src/personaScope.ts",
    ]
    assert [str(path.relative_to(ROOT)) for path in retired if path.exists()] == []


def test_agent_package_exports_only_openloop_runtime():
    import openloop.agents as agents

    assert agents.__all__ == [
        "Agent",
        "AgentContext",
        "openloop_agent",
        "get_agent",
        "list_agents",
    ]


def test_tui_uses_the_unified_engine_builder():
    source = (ROOT / "openloop/tui/app.py").read_text(encoding="utf-8")
    assert "build_code_engine" not in source
    assert "openloop_agent" in source


def test_distribution_does_not_package_persona_manifests():
    config = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert "personas/" not in config
    assert "pyyaml" not in config.lower()


def test_agent_registry_describes_the_unified_runtime():
    source = (ROOT / "openloop/agents/registry.py").read_text(encoding="utf-8")
    assert "persona registry" not in source.lower()
    assert "legacy personal-helper" not in source.lower()
