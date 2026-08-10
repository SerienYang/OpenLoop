"""OpenLoop runtime definition.

The agent owns its system prompt, base toolset, and workspace requirements. Skills remain
loadable capabilities layered onto that runtime.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from ..tools.todo import TodoList


@dataclass
class AgentContext:
    workspace: Optional[Path] = None
    executor: Optional[Any] = None
    todo: Optional[TodoList] = None
    # Shared, mutable list of RootDir the session may touch (primary scratch + added folders).
    # When None, tools fall back to the single `workspace` root. Held by reference so runtime
    # add/remove of folders is seen by the file tools built from it.
    roots: Optional[list] = None


@dataclass
class Agent:
    name: str
    title: str
    system_prompt: str
    needs_workspace: bool = False
    tool_factory: Optional[Callable[[AgentContext], list]] = None
    # Runtime traits used by engine assembly.
    family: str = "knowledge"
    messaging: bool = False
    connectors: bool = False

    def build_tools(self, context: AgentContext) -> list:
        return list(self.tool_factory(context)) if self.tool_factory else []
