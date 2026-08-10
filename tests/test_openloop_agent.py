from openloop.agents.openloop import OPENLOOP_CAPABILITIES, openloop_agent


def test_openloop_agent_traits():
    agent = openloop_agent()
    assert agent.name == "openloop"
    assert agent.needs_workspace is True
    assert agent.messaging is True
    assert agent.connectors is True
    assert agent.family == "knowledge"
    prompt = agent.system_prompt.lower()
    assert "openloop" in prompt


def test_openloop_capabilities_are_multiroot_and_code_capable():
    assert OPENLOOP_CAPABILITIES == ["files", "git", "search", "shell", "todo"]
