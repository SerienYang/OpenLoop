"""Agent registry for the single OpenLoop runtime."""

from __future__ import annotations

from .base import Agent
from .openloop import openloop_agent


def get_agent(name: str) -> Agent:
    if name != "openloop":
        raise KeyError(f"Unknown agent: {name}")
    return openloop_agent()


def list_agents() -> list[dict]:
    agent = openloop_agent()
    return [
        {
            "name": agent.name,
            "title": agent.title,
            "needs_workspace": agent.needs_workspace,
            "family": agent.family,
            "messaging": agent.messaging,
            "connectors": agent.connectors,
        }
    ]
