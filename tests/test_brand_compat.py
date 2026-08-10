from __future__ import annotations

import os
import re
import subprocess
import tomllib
from pathlib import Path

import pytest

from openloop.secrets import state_dir
from openloop.server.run import _ensure_api_token


ROOT = Path(__file__).resolve().parents[1]


def _compact_ascii(value: bytes) -> bytes:
    return value.lower().translate(None, b" \t\r\n_-")


def test_repository_has_only_openloop_names() -> None:
    retired_stems = tuple(
        "".join(parts).encode()
        for parts in (("open", "worker"), ("co", "work"))
    )
    tracked = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout.split(b"\0")
    offenders: list[str] = []

    for raw_path in filter(None, tracked):
        path = ROOT / os.fsdecode(raw_path)
        if not path.is_file():
            continue
        if any(stem in _compact_ascii(raw_path) for stem in retired_stems):
            offenders.append(os.fsdecode(raw_path))
        content = path.read_bytes()
        if b"\0" in content:
            continue
        if any(stem in _compact_ascii(content) for stem in retired_stems):
            offenders.append(os.fsdecode(raw_path))

    assert sorted(set(offenders)) == []


def test_readme_has_no_legacy_brand_names() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    legacy_brand = re.compile(r"\b(?:open[\s_-]?worker|co[\s_-]?worker)\b", re.IGNORECASE)

    assert legacy_brand.search(readme) is None


def test_console_scripts_are_openloop_only() -> None:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert data["project"]["scripts"] == {
        "openloop": "openloop.cli:main",
        "openloop-server": "openloop.server.run:main",
        "openloop-connectors": "openloop.connectors.cli:main",
    }


@pytest.mark.parametrize("platform", ["darwin", "linux"])
def test_posix_state_dir_uses_openloop_only(
    platform: str, tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr("openloop.secrets.sys.platform", platform)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("OPENLOOP_STATE_DIR", raising=False)

    assert state_dir() == tmp_path / ".config" / "openloop"


def test_windows_state_dir_uses_openloop_only(
    tmp_path: Path, monkeypatch
) -> None:
    appdata = tmp_path / "AppData" / "Roaming"
    monkeypatch.setattr("openloop.secrets.sys.platform", "win32")
    monkeypatch.setenv("APPDATA", str(appdata))
    monkeypatch.delenv("OPENLOOP_STATE_DIR", raising=False)

    assert state_dir() == appdata / "openloop"


def test_explicit_openloop_state_dir_is_honored(
    tmp_path: Path, monkeypatch
) -> None:
    explicit = tmp_path / ".config" / "openloop"
    monkeypatch.setenv("OPENLOOP_STATE_DIR", str(explicit))

    assert state_dir() == explicit


def test_openloop_api_token_is_reused(monkeypatch) -> None:
    monkeypatch.setenv("OPENLOOP_API_TOKEN", "current-token")

    assert _ensure_api_token(8765) is None
    assert os.environ["OPENLOOP_API_TOKEN"] == "current-token"
