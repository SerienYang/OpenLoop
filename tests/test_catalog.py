"""The vetted tool catalog behind the unified OpenLoop runtime."""

from __future__ import annotations

import pytest

from openloop.agents.base import AgentContext
from openloop.agents.openloop import OPENLOOP_CAPABILITIES, openloop_agent
from openloop.catalog import CATALOG, capability, expand, risk_summary
from openloop.risk import RiskClass
from openloop.tools.todo import TodoList

OPENLOOP_TOOLS = {
    "list_files",
    "read_file",
    "read_file_lines",
    "write_file",
    "apply_unified_diff",
    "apply_patch",
    "replace_in_file",
    "git_status",
    "git_diff",
    "git_log",
    "grep",
    "run_shell",
    "shell_task_output",
    "shell_task_kill",
    "todo_write",
}


def _names(tools) -> set:
    return {getattr(t, "__name__", "") for t in tools}


def _full_context(tmp_path) -> AgentContext:
    return AgentContext(workspace=tmp_path, executor=object(), todo=TodoList())


def test_catalog_registers_expected_ids():
    assert set(CATALOG) == {"files", "git", "search", "shell", "todo"}
    for cap in CATALOG.values():
        assert cap.id and cap.name and callable(cap.build)


def test_expand_openloop_matches_expected(tmp_path):
    tools = expand(OPENLOOP_CAPABILITIES, _full_context(tmp_path))
    assert _names(tools) == OPENLOOP_TOOLS


def test_openloop_agent_uses_catalog(tmp_path):
    ctx = _full_context(tmp_path)
    assert _names(openloop_agent().build_tools(ctx)) == OPENLOOP_TOOLS


def test_requirements_skip_unavailable(tmp_path):
    # No executor → no shell; no todo → no todo_write; no workspace → no files/git/search.
    no_exec = AgentContext(workspace=tmp_path, executor=None, todo=TodoList())
    assert "run_shell" not in _names(expand(OPENLOOP_CAPABILITIES, no_exec))
    assert "todo_write" in _names(expand(OPENLOOP_CAPABILITIES, no_exec))

    no_todo = AgentContext(workspace=tmp_path, executor=object(), todo=None)
    assert "todo_write" not in _names(expand(OPENLOOP_CAPABILITIES, no_todo))
    assert "run_shell" in _names(expand(OPENLOOP_CAPABILITIES, no_todo))

    no_ws = AgentContext(workspace=None, executor=object(), todo=TodoList())
    names = _names(expand(OPENLOOP_CAPABILITIES, no_ws))
    assert names == {"run_shell", "shell_task_output", "shell_task_kill", "todo_write"}


def test_risk_summary():
    assert risk_summary(["shell"]) == {RiskClass.EXEC}
    assert risk_summary(["files"]) == {RiskClass.READ, RiskClass.WRITE_LOCAL}
    assert risk_summary(["git", "search"]) == {RiskClass.READ}


def test_unknown_capability_raises():
    with pytest.raises(KeyError):
        capability("does_not_exist")
