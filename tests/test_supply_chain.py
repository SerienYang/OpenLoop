import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_gui_dependencies_use_patched_versions():
    package = json.loads((ROOT / "surfaces/gui/package.json").read_text())
    assert package["dependencies"]["xlsx"] == (
        "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
    )
    assert package["devDependencies"]["vite"] == "^8.2.0"
    assert package["devDependencies"]["vitest"] == "^4.1.10"
    assert package["devDependencies"]["postcss"] == "^8.5.25"
    assert package["devDependencies"]["@vitejs/plugin-react"] == "^6.0.5"

    lock = json.loads((ROOT / "surfaces/gui/package-lock.json").read_text())
    assert lock["packages"]["node_modules/xlsx"]["version"] == "0.20.3"


def test_github_actions_are_pinned_to_commit_shas():
    workflows = list((ROOT / ".github/workflows").glob("*.yml"))
    uses = []
    for workflow in workflows:
        uses.extend(re.findall(r"uses:\s*[^@\s]+@([^\s#]+)", workflow.read_text()))
    assert uses
    assert [ref for ref in uses if not re.fullmatch(r"[0-9a-f]{40}", ref)] == []


def test_python_ci_and_release_use_the_frozen_uv_lock():
    assert (ROOT / "uv.lock").is_file()
    pyproject = (ROOT / "pyproject.toml").read_text()
    assert re.search(r"release\s*=\s*\[[^\]]*pyinstaller", pyproject, re.DOTALL)

    ci = (ROOT / ".github/workflows/ci.yml").read_text()
    release = (ROOT / ".github/workflows/release.yml").read_text()
    dev_setup = (ROOT / "packaging/setup_dev_env.sh").read_text()
    assert "uv sync --frozen" in ci
    assert "uv sync --frozen" in release
    assert "--extra messaging --extra browser --extra bedrock --extra release" in release
    assert 'pip install -e ".' not in ci
    assert 'pip install -e ".' not in release
    assert "uv sync --frozen" in dev_setup
    assert "/pip" not in dev_setup
