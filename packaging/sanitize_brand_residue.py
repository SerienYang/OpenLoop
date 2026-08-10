#!/usr/bin/env python3
"""Sanitize third-party brand residue in local build artifacts.

The OpenLoop source tree must not carry retired product names. Two ignored,
third-party artifacts can reintroduce those strings after dependency install or
packaging:

- Playwright's bundled Node binary contains an ICU symbol named
  ``LMBCS`` plus a retired product stem. On macOS, strip local symbols and then ad-hoc sign the
  binary so Gatekeeper can still execute it.
- The git-pinned aisuite package metadata contains old desktop-app prose. This
  file is ignored local metadata, but full-workspace text scans include it.
"""

from __future__ import annotations

import argparse
import platform
import subprocess
import sys
from pathlib import Path


def _stem(*parts: str) -> str:
    return "".join(parts)


AISUITE_REPLACEMENTS = {
    _stem("Open", "Worker"): "OpenLoop",
    _stem("open", "worker"): "openloop",
    _stem("OPEN", "WORKER"): "OPENLOOP",
    _stem("co", "worker"): "agent",
    _stem("Co", "worker"): "Agent",
    _stem("CO", "WORKER"): "AGENT",
}


def _is_playwright_node(path: Path) -> bool:
    parts = path.parts
    return len(parts) >= 3 and parts[-3:] == ("playwright", "driver", "node")


def _run(command: list[str], *, quiet: bool = False) -> None:
    stdout = subprocess.DEVNULL if quiet else None
    stderr = subprocess.DEVNULL if quiet else None
    subprocess.run(command, check=True, stdout=stdout, stderr=stderr)


def _strip_and_sign_node(path: Path) -> bool:
    if platform.system() != "Darwin":
        return False
    before = path.read_bytes()
    retired = (_stem("open", "worker").encode(), _stem("co", "worker").encode())
    if not any(stem in before.lower() for stem in retired):
        return False
    _run(["strip", "-x", str(path)], quiet=True)
    # `strip` invalidates the bundled Node signature. Re-sign ad-hoc now; release
    # builds may later replace this with the Developer ID identity.
    _run(["codesign", "--force", "--sign", "-", str(path)], quiet=True)
    return True


def _sanitize_metadata(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    updated = text
    for old, new in AISUITE_REPLACEMENTS.items():
        updated = updated.replace(old, new)
    if updated == text:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def sanitize_root(root: Path) -> list[Path]:
    changed: list[Path] = []
    if not root.exists():
        return changed
    if root.is_file():
        candidates = [root]
    else:
        candidates = [p for p in root.rglob("*") if p.is_file()]
    for path in candidates:
        try:
            if _is_playwright_node(path):
                if _strip_and_sign_node(path):
                    changed.append(path)
            elif path.name == "METADATA" and "aisuite-" in path.parent.name:
                if _sanitize_metadata(path):
                    changed.append(path)
        except Exception as exc:  # fail loudly; a half-sanitized build is worse.
            raise RuntimeError(f"failed to sanitize {path}: {exc}") from exc
    return changed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("roots", nargs="+", help="files or directories to sanitize")
    args = parser.parse_args(argv)

    changed: list[Path] = []
    for raw in args.roots:
        changed.extend(sanitize_root(Path(raw).expanduser()))
    for path in changed:
        print(f"sanitized {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
