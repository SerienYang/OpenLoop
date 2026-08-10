#!/usr/bin/env bash
# Quick rebuild: reuse the existing PyInstaller onedir (packaging/dist) and only
# re-stage the sidecar, rebuild the frontend + Tauri app, and wrap the DMG.
set -euo pipefail

PLATFORM="$(cd "$(dirname "$0")/.." && pwd)"
GUI=$PLATFORM/surfaces/gui
APP=OpenLoop
VERSION="$(node -p "require('$GUI/src-tauri/tauri.conf.json').version")"
TRIPLE="$(rustc -vV | sed -n 's/host: //p')"
ARCH="${TRIPLE%%-*}"
BUNDLE_APP="$GUI/src-tauri/target/release/bundle/macos/$APP.app"
BUILD_START="$(date +%s)"

echo "==> [1/3] staging sidecar (reusing packaging/dist onedir)"
"$PLATFORM/.venv/bin/python" "$PLATFORM/packaging/sanitize_brand_residue.py" "$PLATFORM/packaging/dist/openloop-server"
mkdir -p "$GUI/src-tauri/binaries"
rm -rf "$GUI/src-tauri/binaries/sidecar" \
  "$GUI/src-tauri/binaries/openloop-server-$TRIPLE"
cp -RL "$PLATFORM/packaging/dist/openloop-server" "$GUI/src-tauri/binaries/sidecar"
if [ -n "$(find "$GUI/src-tauri/binaries/sidecar" -type l | head -1)" ]; then
  echo "ERROR: symlinks survived sidecar staging" >&2; exit 1
fi
rm -rf "$GUI/src-tauri/binaries/sidecar/_internal/Python.framework"
if [ -n "$(find "$GUI/src-tauri/binaries/sidecar" -type d -name "*.framework" | head -1)" ]; then
  echo "ERROR: a .framework appeared in the sidecar" >&2; exit 1
fi
chmod +x "$GUI/src-tauri/binaries/sidecar/openloop-server"
"$PLATFORM/.venv/bin/python" "$PLATFORM/packaging/sanitize_brand_residue.py" "$GUI/src-tauri/binaries/sidecar"

echo "==> [2/3] tauri build (.app) — frontend + Rust incremental"
rm -rf "$BUNDLE_APP"
( cd "$GUI" && npm run tauri build -- --bundles app )
"$PLATFORM/.venv/bin/python" "$PLATFORM/packaging/sanitize_brand_residue.py" "$GUI/src-tauri/target/release/sidecar"
[ -d "$BUNDLE_APP" ] || { echo "ERROR: tauri build did not produce $BUNDLE_APP" >&2; exit 1; }
APP_BIN="$BUNDLE_APP/Contents/MacOS/openloop-desktop"
[ -f "$APP_BIN" ] || { echo "ERROR: missing app executable" >&2; exit 1; }
APP_BIN_MTIME="$(stat -f %m "$APP_BIN")"
if [ "${APP_BIN_MTIME:-0}" -lt "$BUILD_START" ]; then
  echo "ERROR: bundle executable is older than this build start" >&2; exit 1
fi

echo "==> [3/3] hdiutil: wrapping into .dmg"
BUNDLE="$GUI/src-tauri/target/release/bundle"
STAGING="$(mktemp -d)"
cp -R "$BUNDLE/macos/$APP.app" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
mkdir "$STAGING/.background"
cp "$PLATFORM/packaging/dmg-background.tiff" "$STAGING/.background/bg.tiff"
DMG="$BUNDLE/dmg/${APP}_${VERSION}_${ARCH}.dmg"
mkdir -p "$(dirname "$DMG")"
rm -f "$DMG"
hdiutil create -volname "$APP" -srcfolder "$STAGING" -ov -format UDZO -imagekey zlib-level=9 "$DMG" >/dev/null
echo "==> DONE: $DMG"
ls -lh "$DMG"
