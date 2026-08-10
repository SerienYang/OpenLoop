#!/usr/bin/env bash
# One-time dev bootstrap for a fresh checkout: syncs the locked Python environment
# every from-source flow expects at .venv. The browser dev flow runs its
# openloop-server directly, and the Tauri desktop shell falls back to it when
# no packaged sidecar binary is present (src-tauri/src/lib.rs, resolution step 3).
#
# Usage: bash packaging/setup_dev_env.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv"

command -v uv >/dev/null || {
  echo "uv is required: https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
}

(cd "$ROOT" && uv sync --frozen --extra messaging --extra browser --extra dev --extra bedrock --extra release)
"$VENV/bin/python" "$ROOT/packaging/sanitize_brand_residue.py" "$VENV"
"$VENV/bin/python" -c 'import aisuite, openloop'
echo "Ready: $VENV"
echo "  server: $VENV/bin/openloop-server --cwd /path/to/your/project --port 8765"
