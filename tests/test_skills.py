"""OpenLoop Agent + SKILL.md loader (catalog + load_skill)."""

from __future__ import annotations

import pytest

from openloop.agent import build_engine
from openloop.agents import AgentContext, get_agent, openloop_agent
from openloop.providers import ModelCapabilities
from openloop.skills import SkillLoader, skill_catalog_text, skill_tools
from openloop.tools import ToolRegistry
from openloop.tools.shell import LocalExecutor
from openloop.tools.todo import TodoList


class _Stub:
    def complete(self, **kwargs):  # pragma: no cover
        raise NotImplementedError

    def capabilities(self, model):
        return ModelCapabilities()


# -- agents ---------------------------------------------------------------------


def test_openloop_agent_tools(tmp_path):
    ex = LocalExecutor(cwd=tmp_path, default_timeout=5)
    try:
        ctx = AgentContext(workspace=tmp_path, executor=ex, todo=TodoList())
        names = {getattr(t, "__name__", "?") for t in openloop_agent().build_tools(ctx)}
        assert {
            "read_file",
            "write_file",
            "git_status",
            "run_shell",
            "todo_write",
        } <= names
    finally:
        ex.close()


def test_get_agent_accepts_only_openloop():
    assert get_agent("openloop").name == "openloop"
    with pytest.raises(KeyError, match="nope"):
        get_agent("nope")


# -- SKILL.md loader ------------------------------------------------------------


def _make_skill(skills_dir, name, desc, body):
    d = skills_dir / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {desc}\n---\n{body}", encoding="utf-8"
    )


def test_skill_loader_catalog_and_load(tmp_path):
    skills_dir = tmp_path / "skills"
    _make_skill(
        skills_dir, "pdf", "extract text from PDFs", "Use pdfplumber to extract text."
    )
    loader = SkillLoader([skills_dir])

    assert loader.catalog() == [
        {"name": "pdf", "description": "extract text from PDFs"}
    ]
    assert "pdf: extract text from PDFs" in skill_catalog_text(loader)

    reg = ToolRegistry()
    reg.register_all(skill_tools(loader))
    loaded = reg.execute("load_skill", {"name": "pdf"})
    assert "pdfplumber" in loaded["instructions"]
    assert reg.execute("load_skill", {"name": "missing"})["error"]


# -- engine assembly per agent --------------------------------------------------


def test_build_engine_openloop_has_agents_md_and_skills(tmp_path):
    (tmp_path / "AGENTS.md").write_text("PROJECT RULE: prefer pathlib.")
    engine = build_engine(agent=openloop_agent(), workspace=tmp_path, provider=_Stub())
    try:
        assert "prefer pathlib" in engine.messages[0]["content"]
        assert "read_file" in engine.registry.names()
        assert "todo_write" in engine.registry.names()
        assert "load_skill" in engine.registry.names()
        assert engine.agent_name == "openloop"
    finally:
        engine.executor.close()
