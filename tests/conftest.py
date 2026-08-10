"""Shared pytest fixtures.

`fake_slack` boots the in-process FakeSlack harness on an ephemeral port and points the Slack
adapter at it via `SLACK_API_URL`, so the real `SlackAdapter` / `slack_bolt` stack runs
end-to-end with no network, tokens, or the Slack app console. See
`openloop.testing.fake_slack` and `platform/docs/FAKE-SLACK-SPEC.md`.
"""

from __future__ import annotations

import pytest
import pytest_asyncio

from openloop.testing.fake_slack import FakeSlack


@pytest.fixture(autouse=True)
def _isolated_state_dir(tmp_path, monkeypatch):
    """EVERY test gets an isolated SecretStore/state dir. Without this, any test that builds
    a SessionManager could read the developer's real machine-global state."""
    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(tmp_path / "openloop-state"))
    monkeypatch.delenv("OPENLOOP_API_TOKEN", raising=False)
    monkeypatch.delenv("OPENLOOP_API_TOKEN", raising=False)


@pytest_asyncio.fixture
async def fake_slack(monkeypatch):
    """A running FakeSlack control object; `SLACK_API_URL` is set to it for the test's duration."""
    fake = FakeSlack()
    await fake.start()
    monkeypatch.setenv("SLACK_API_URL", fake.api_url)
    try:
        yield fake
    finally:
        await fake.stop()
