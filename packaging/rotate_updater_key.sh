#!/bin/bash
set -Eeuo pipefail
umask 077
set +x

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
if [ "${OPENLOOP_KEY_ROTATION_TESTING:-0}" = "1" ] \
  && [ -n "${OPENLOOP_KEY_ROTATION_REPO_ROOT:-}" ]; then
  ROOT="$OPENLOOP_KEY_ROTATION_REPO_ROOT"
fi
GUI="$ROOT/surfaces/gui"
HELPER="$HERE/updater_key_rotation.py"
VERIFIER_MANIFEST="$HERE/updater-verifier/Cargo.toml"
PYTHON="${OPENLOOP_KEY_ROTATION_PYTHON:-$ROOT/.venv/bin/python}"
DEFAULT_KEY_ROOT="$HOME/.config/openloop/keys"
CONFIRM_PHRASE="ROTATE OPENLOOP UPDATER KEY"
TEMP_ROOT=""
TEMP_ROOT_PARENT=""
TRANSACTION_ACTIVE=0
SNAPSHOT_DIR=""
KEY_STAGE=""
KEY_STAGE_ROOT=""
PREPARED_PARTIAL_DIR=""
PREPARED_BACKUP_TARGET=""

usage() {
  cat <<'EOF'
Usage:
  rotate_updater_key.sh prepare --backup-dir PATH [--key-root PATH] [--repo OWNER/REPO]
  rotate_updater_key.sh resume-prepare --key-dir PATH [--allow-non-volume-backup]
  rotate_updater_key.sh verify-backup --backup-path PATH [--allow-non-volume-backup]
  rotate_updater_key.sh activate --key-dir PATH [--allow-non-volume-backup]
  rotate_updater_key.sh sync-github --key-dir PATH [--remote origin] [--repo OWNER/REPO] [--allow-non-volume-backup]

Options:
  --allow-non-volume-backup   Allow a backup outside /Volumes (testing only)
  --dry-run                   Print the public operations without changing state
EOF
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  preserve_temp=0
  if [ "$TRANSACTION_ACTIVE" -eq 1 ] && [ -n "$SNAPSHOT_DIR" ] && [ -d "$SNAPSHOT_DIR" ]; then
    if ! "$PYTHON" "$HELPER" restore-public-files \
      --repo-root "$ROOT" --snapshot-dir "$SNAPSHOT_DIR"; then
      echo "error: rollback failed; snapshot preserved at $SNAPSHOT_DIR" >&2
      status=1
      preserve_temp=1
    fi
  fi
  if [ -n "$KEY_STAGE" ] && { [ -e "$KEY_STAGE" ] || [ -L "$KEY_STAGE" ]; }; then
    if [ -n "$KEY_STAGE_ROOT" ] \
      && [[ "$KEY_STAGE" == "$KEY_STAGE_ROOT"/.partial-pending.* ]] \
      && [ -d "$KEY_STAGE" ] \
      && [ ! -L "$KEY_STAGE" ] \
      && [ -O "$KEY_STAGE" ]; then
      if [ -f "$KEY_STAGE/updater.key" ]; then
        echo "Updater key generation was interrupted; resume the same key with:" >&2
        echo "  bash packaging/rotate_updater_key.sh resume-prepare --key-dir $KEY_STAGE" >&2
      else
        rm -rf "$KEY_STAGE" || {
          echo "error: failed to remove updater key staging directory: $KEY_STAGE" >&2
          status=1
        }
      fi
    else
      echo "error: unsafe updater key staging directory preserved: $KEY_STAGE" >&2
      status=1
    fi
  fi
  if [ "$preserve_temp" -eq 0 ] \
    && [ -n "$TEMP_ROOT" ] \
    && [[ "$TEMP_ROOT" == "${TEMP_ROOT_PARENT:-$(temp_root_parent)}"/openloop-updater-key.* ]] \
    && [ -d "$TEMP_ROOT" ] \
    && [ -O "$TEMP_ROOT" ]; then
    rm -rf "$TEMP_ROOT"
  fi
  exit "$status"
}
on_interrupt() {
  trap - INT TERM
  exit 130
}
on_terminate() {
  trap - INT TERM
  exit 143
}
trap cleanup EXIT
trap on_interrupt INT
trap on_terminate TERM

temp_root_parent() {
  base="${TMPDIR:-/tmp}"
  base="${base%/}"
  [ -n "$base" ] || base="/tmp"
  printf '%s\n' "$base"
}

make_temp_root() {
  TEMP_ROOT_PARENT="$(temp_root_parent)"
  mkdir -p "$TEMP_ROOT_PARENT"
  mktemp -d "$TEMP_ROOT_PARENT/openloop-updater-key.XXXXXX"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: required command not found: $1" >&2
    exit 1
  }
}

json_value() {
  file="$1"
  expression="$2"
  "$PYTHON" - "$file" "$expression" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
for part in sys.argv[2].split("."):
    value = value[part]
print(value)
PY
}

public_key_id_from_document() {
  awk 'NR == 1 { print $NF }' "$1"
}

ensure_common_tools() {
  if [ "${OPENLOOP_KEY_ROTATION_TESTING:-0}" != "1" ] && [ "$(uname -s)" != "Darwin" ]; then
    echo "error: updater key rotation is supported on macOS only" >&2
    exit 1
  fi
  for command in npm cargo gh git security; do
    require_command "$command"
  done
  [ -x "$PYTHON" ] || {
    echo "error: missing project Python environment: $ROOT/.venv" >&2
    exit 1
  }
}

sign_and_verify() {
  key_path="$1"
  public_document="$2"
  use_keychain="$3"
  key_id="$(public_key_id_from_document "$public_document")"
  canary="$TEMP_ROOT/canary-$key_id"
  printf 'OpenLoop updater key check %s\n' "$key_id" > "$canary"
  if [ "${OPENLOOP_KEY_ROTATION_TESTING:-0}" = "1" ]; then
    return 0
  fi
  if [ "$use_keychain" = "1" ]; then
    service="OpenLoop Updater Signing Key $key_id"
    key_password="$(security find-generic-password -a "$USER" -s "$service" -w)"
    [ -n "$key_password" ] || {
      unset key_password
      echo "error: updater signing key password must not be empty" >&2
      return 1
    }
    TAURI_SIGNING_PRIVATE_KEY_PATH="$key_path" \
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$key_password" \
      npm --prefix "$GUI" run tauri -- signer sign "$canary" >/dev/null
    unset key_password
  else
    env -u TAURI_SIGNING_PRIVATE_KEY \
      -u TAURI_SIGNING_PRIVATE_KEY_PATH \
      -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
      npm --prefix "$GUI" run tauri -- signer sign \
      --private-key-path "$key_path" "$canary" >/dev/null
  fi
  cargo run --quiet --locked --manifest-path "$VERIFIER_MANIFEST" -- \
    "$canary" "$canary.sig" "$public_document"
}

repository_json() {
  repo="${1:-}"
  if [ -n "$repo" ]; then
    gh repo view "$repo" --json id,nameWithOwner,url,defaultBranchRef
  else
    gh repo view --json id,nameWithOwner,url,defaultBranchRef
  fi
}

normalize_repository_json() {
  source_file="$1"
  destination="$2"
  "$PYTHON" - "$source_file" "$destination" <<'PY'
import json, pathlib, sys, urllib.parse
raw = json.loads(pathlib.Path(sys.argv[1]).read_text())
url = urllib.parse.urlparse(raw["url"])
normalized = {
    "id": raw["id"],
    "host": url.hostname,
    "name_with_owner": raw["nameWithOwner"],
    "default_branch": raw["defaultBranchRef"]["name"],
}
pathlib.Path(sys.argv[2]).write_text(json.dumps(normalized, indent=2, sort_keys=True) + "\n")
PY
}

volume_uuid_for_path() {
  path="$1"
  device="$(df -P "$path" | tail -1 | awk '{print $1}')"
  [ -n "$device" ] || {
    echo "error: unable to determine backup volume device: $path" >&2
    return 1
  }
  diskutil info -plist "$device" > "$TEMP_ROOT/volume-identity.plist"
  "$PYTHON" - "$TEMP_ROOT/volume-identity.plist" <<'PY'
import pathlib, plistlib, sys
uuid = plistlib.loads(pathlib.Path(sys.argv[1]).read_bytes()).get("VolumeUUID")
if not uuid:
    raise SystemExit("backup volume has no UUID")
print(uuid)
PY
}

volume_details() {
  backup_dir="$1"
  output="$2"
  if [ "${OPENLOOP_KEY_ROTATION_TESTING:-0}" = "1" ]; then
    test_root="${OPENLOOP_KEY_ROTATION_TEST_VOLUME_ROOT:-$backup_dir}"
    "$PYTHON" - "$test_root" "$backup_dir" "$output" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
path = pathlib.Path(sys.argv[2]).resolve()
relative = path.relative_to(root)
relative_text = "" if str(relative) == "." else str(relative)
pathlib.Path(sys.argv[3]).write_text(json.dumps({
    "uuid": "TEST-VOLUME",
    "mount_root": str(root),
    "base_relative_path": relative_text,
}) + "\n")
PY
    return
  fi
  device="$(df -P "$backup_dir" | tail -1 | awk '{print $1}')"
  [ -n "$device" ] || {
    echo "error: unable to determine backup volume device: $backup_dir" >&2
    return 1
  }
  diskutil info -plist "$device" > "$TEMP_ROOT/volume.plist"
  "$PYTHON" - "$TEMP_ROOT/volume.plist" "$backup_dir" "$output" <<'PY'
import pathlib, plistlib, sys
import json
info = plistlib.loads(pathlib.Path(sys.argv[1]).read_bytes())
physical_root = pathlib.Path(info.get("MountPoint") or "")
backup = pathlib.Path(sys.argv[2]).resolve()
uuid = info.get("VolumeUUID")
if not uuid:
    raise SystemExit("volume has no UUID")
try:
    relative = backup.relative_to(physical_root.resolve())
    root = physical_root.resolve()
except ValueError:
    root = pathlib.Path("/")
    relative = backup.relative_to(root)
pathlib.Path(sys.argv[3]).write_text(json.dumps({
    "uuid": str(uuid),
    "mount_root": str(root),
    "base_relative_path": str(relative),
}) + "\n")
PY
}

locate_backup_from_metadata() {
  metadata="$1"
  expected_uuid="$(json_value "$metadata" backup_volume_uuid)"
  relative_path="$(json_value "$metadata" backup_relative_path)"
  if [ "${OPENLOOP_KEY_ROTATION_TESTING:-0}" = "1" ] \
    && [ -n "${OPENLOOP_KEY_ROTATION_TEST_VOLUME_ROOT:-}" ]; then
    printf '%s/%s\n' "$OPENLOOP_KEY_ROTATION_TEST_VOLUME_ROOT" "$relative_path"
    return
  fi
  recorded_root="$(json_value "$metadata" backup_mount_root)"
  recorded_path="$recorded_root/$relative_path"
  if [ -d "$recorded_path" ]; then
    actual_uuid="$(volume_uuid_for_path "$recorded_path")"
    if [ "$actual_uuid" = "$expected_uuid" ]; then
      printf '%s\n' "$recorded_path"
      return
    fi
  fi
  for volume_root in /Volumes/*; do
    [ -d "$volume_root" ] || continue
    actual_uuid="$(volume_uuid_for_path "$volume_root" 2>/dev/null || true)"
    if [ "$actual_uuid" = "$expected_uuid" ]; then
      printf '%s/%s\n' "$volume_root" "$relative_path"
      return
    fi
  done
  echo "error: backup volume UUID is not mounted: $expected_uuid" >&2
  return 1
}

validate_backup_path() {
  candidate="$1"
  allow_non_volume="${2:-0}"
  validate_args=(validate-path --path "$candidate" --repo-root "$ROOT")
  if [ "${OPENLOOP_KEY_ROTATION_TESTING:-0}" = "1" ] \
    || [ "$allow_non_volume" -eq 1 ]; then
    validate_args+=(--allow-non-volume)
  fi
  "$PYTHON" "$HELPER" "${validate_args[@]}"
}

finalize_pending_key() {
  pending_dir="$1"
  allow_non_volume="${2:-0}"
  context="$pending_dir/prepare-context.json"
  [ -f "$pending_dir/updater.key" ] && [ -f "$pending_dir/updater.key.pub" ] || {
    echo "error: pending updater key is incomplete: $pending_dir" >&2
    return 1
  }
  chmod 600 "$pending_dir/updater.key" "$pending_dir/updater.key.pub"

  if [ ! -f "$pending_dir/metadata.json" ] \
    || [ ! -f "$pending_dir/rotation-state.json" ]; then
    [ -f "$context" ] || {
      echo "error: pending updater key prepare context is missing" >&2
      return 1
    }
    info_json="$TEMP_ROOT/key-info.json"
    "$PYTHON" "$HELPER" inspect-key \
      --public-key-file "$pending_dir/updater.key.pub" > "$info_json"
    key_id="$(json_value "$info_json" key_id)"
    document_b64="$(json_value "$info_json" document_base64)"
    printf '%s' "$document_b64" | base64 -d > "$pending_dir/updater.pub"
    chmod 600 "$pending_dir/updater.pub"
    base_relative="$(json_value "$context" backup_base_relative_path)"
    backup_name="OpenLoop-updater-$key_id-$(json_value "$context" timestamp)"
    if [ -n "$base_relative" ]; then
      backup_relative="$base_relative/$backup_name"
    else
      backup_relative="$backup_name"
    fi
    "$PYTHON" - "$context" "$TEMP_ROOT/repository.json" <<'PY'
import json, pathlib, sys
context = json.loads(pathlib.Path(sys.argv[1]).read_text())
pathlib.Path(sys.argv[2]).write_text(
    json.dumps(context["repository"], indent=2, sort_keys=True) + "\n"
)
PY
    "$PYTHON" "$HELPER" write-metadata \
      --key-dir "$pending_dir" \
      --repository-json "$TEMP_ROOT/repository.json" \
      --backup-volume-uuid "$(json_value "$context" backup_volume_uuid)" \
      --backup-mount-root "$(json_value "$context" backup_mount_root)" \
      --backup-relative-path "$backup_relative" \
      --previous-public-key-b64 "$(json_value "$context" previous_public_key_base64)"
  else
    key_id="$(json_value "$pending_dir/metadata.json" current_key_id)"
    backup_relative="$(json_value "$pending_dir/metadata.json" backup_relative_path)"
  fi

  if [ -f "$context" ]; then
    backup_target="$(json_value "$context" backup_mount_root)/$backup_relative"
  else
    backup_target="$(locate_backup_from_metadata "$pending_dir/metadata.json")"
  fi
  backup_target="$(validate_backup_path "$backup_target" "$allow_non_volume")"
  partial_dir="$(dirname "$pending_dir")/.partial-$key_id"
  [ ! -e "$partial_dir" ] || {
    echo "error: partial key directory already exists; use resume-prepare" >&2
    return 1
  }
  "$PYTHON" "$HELPER" discard-prepare-context --key-dir "$pending_dir"
  mv "$pending_dir" "$partial_dir"
  KEY_STAGE=""
  KEY_STAGE_ROOT=""
  PREPARED_PARTIAL_DIR="$partial_dir"
  PREPARED_BACKUP_TARGET="$backup_target"
}

prepare_continue() {
  partial_dir="$1"
  backup_target="$2"
  key_id="$(json_value "$partial_dir/rotation-state.json" key_id)"
  state="$(json_value "$partial_dir/rotation-state.json" state)"
  service="OpenLoop Updater Signing Key $key_id"

  if [ "$state" = "generated" ]; then
    if [ "${OPENLOOP_KEY_ROTATION_TESTING:-0}" != "1" ]; then
      echo "Store the same high-entropy key password in macOS Keychain."
      security add-generic-password -U -a "$USER" -s "$service" -T "" -w
    fi
    sign_and_verify "$partial_dir/updater.key" "$partial_dir/updater.pub" 1
    "$PYTHON" "$HELPER" advance-journal \
      --key-dir "$partial_dir" --state keychain_saved
    state="keychain_saved"
  fi

  if [ "$state" = "keychain_saved" ]; then
    if [ -e "$backup_target" ]; then
      for name in updater.key updater.key.pub updater.pub metadata.json SHA256SUMS RECOVERY.md; do
        cmp -s "$partial_dir/$name" "$backup_target/$name" || {
          echo "error: existing backup differs from partial key: $name" >&2
          exit 1
        }
      done
    else
      mkdir -p "$(dirname "$backup_target")"
      "$PYTHON" "$HELPER" copy-key-directory \
        --source "$partial_dir" --target "$backup_target"
    fi
    "$PYTHON" "$HELPER" advance-journal \
      --key-dir "$backup_target" --state backup_copied
    "$PYTHON" "$HELPER" advance-journal \
      --key-dir "$partial_dir" --state backup_copied
    state="backup_copied"
  fi
  if [ "$state" = "backup_copied" ]; then
    sign_and_verify "$backup_target/updater.key" "$backup_target/updater.pub" 0
    "$PYTHON" "$HELPER" advance-journal \
      --key-dir "$backup_target" --state backup_copied
    "$PYTHON" "$HELPER" advance-journal \
      --key-dir "$backup_target" --state backup_verified
    "$PYTHON" "$HELPER" advance-journal \
      --key-dir "$partial_dir" --state backup_verified
    state="backup_verified"
  fi
  if [ "$state" = "backup_verified" ]; then
    "$PYTHON" "$HELPER" advance-journal \
      --key-dir "$backup_target" --state backup_verified
    "$PYTHON" "$HELPER" advance-journal \
      --key-dir "$backup_target" --state complete
    "$PYTHON" "$HELPER" advance-journal \
      --key-dir "$partial_dir" --state complete
    state="complete"
  fi
  if [ "$state" = "complete" ]; then
    final_dir="$(dirname "$partial_dir")/$key_id"
    [ ! -e "$final_dir" ] || {
      echo "error: final key directory already exists: $final_dir" >&2
      exit 1
    }
    mv "$partial_dir" "$final_dir"
    echo "Prepared updater key: $final_dir"
    echo "Verified backup: $backup_target"
  fi
}

prepare_command() {
  backup_dir=""
  key_root="$DEFAULT_KEY_ROOT"
  repo=""
  allow_non_volume=0
  dry_run=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --backup-dir) backup_dir="$2"; shift 2 ;;
      --key-root) key_root="$2"; shift 2 ;;
      --repo) repo="$2"; shift 2 ;;
      --allow-non-volume-backup) allow_non_volume=1; shift ;;
      --dry-run) dry_run=1; shift ;;
      *) echo "error: unknown prepare option: $1" >&2; exit 2 ;;
    esac
  done
  [ -n "$backup_dir" ] || { echo "error: --backup-dir is required" >&2; exit 2; }
  if [ "$dry_run" -eq 1 ]; then
    echo "DRY RUN: would generate, verify, and back up a new updater key"
    echo "DRY RUN: backup=$backup_dir key_root=$key_root"
    return
  fi
  ensure_common_tools
  validate_args=(validate-path --path "$backup_dir" --repo-root "$ROOT")
  [ "$allow_non_volume" -eq 0 ] || validate_args+=(--allow-non-volume)
  backup_dir="$("$PYTHON" "$HELPER" "${validate_args[@]}")"
  key_root="$("$PYTHON" "$HELPER" validate-path \
    --path "$key_root" --repo-root "$ROOT" --allow-non-volume)"
  mkdir -p "$backup_dir"
  mkdir -p "$key_root"
  chmod 700 "$key_root"
  TEMP_ROOT="$(make_temp_root)"
  repository_json "$repo" > "$TEMP_ROOT/repository-raw.json"
  normalize_repository_json "$TEMP_ROOT/repository-raw.json" "$TEMP_ROOT/repository.json"
  volume_details "$backup_dir" "$TEMP_ROOT/volume.json"
  KEY_STAGE_ROOT="$key_root"
  key_stage="$(mktemp -d "$key_root/.partial-pending.XXXXXX")"
  KEY_STAGE="$key_stage"
  chmod 700 "$key_stage"
  previous_public_b64="$("$PYTHON" -c \
    "import json; print(json.load(open('$ROOT/surfaces/gui/src-tauri/tauri.conf.json'))['plugins']['updater']['pubkey'])")"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  "$PYTHON" "$HELPER" write-prepare-context \
    --key-dir "$key_stage" \
    --repository-json "$TEMP_ROOT/repository.json" \
    --volume-json "$TEMP_ROOT/volume.json" \
    --previous-public-key-b64 "$previous_public_b64" \
    --timestamp "$timestamp"
  npm --prefix "$GUI" run tauri -- signer generate \
    --write-keys "$key_stage/updater.key"
  finalize_pending_key "$key_stage" "$allow_non_volume"
  prepare_continue "$PREPARED_PARTIAL_DIR" "$PREPARED_BACKUP_TARGET"
}

resume_prepare_command() {
  key_dir=""
  allow_non_volume=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --key-dir) key_dir="$2"; shift 2 ;;
      --allow-non-volume-backup) allow_non_volume=1; shift ;;
      *) echo "error: unknown resume option: $1" >&2; exit 2 ;;
    esac
  done
  [ -n "$key_dir" ] || {
    echo "error: resume-prepare requires --key-dir" >&2
    exit 2
  }
  ensure_common_tools
  TEMP_ROOT="$(make_temp_root)"
  key_dir="$("$PYTHON" "$HELPER" validate-path \
    --path "$key_dir" --repo-root "$ROOT" --allow-non-volume)"
  if [[ "$(basename "$key_dir")" == .partial-pending.* ]]; then
    KEY_STAGE_ROOT="$(dirname "$key_dir")"
    KEY_STAGE="$key_dir"
    finalize_pending_key "$key_dir" "$allow_non_volume"
    key_dir="$PREPARED_PARTIAL_DIR"
    backup_path="$PREPARED_BACKUP_TARGET"
  else
    backup_path=""
  fi
  metadata="$key_dir/metadata.json"
  [ -f "$metadata" ] || { echo "error: partial key metadata is missing" >&2; exit 1; }
  [ -n "$backup_path" ] || backup_path="$(locate_backup_from_metadata "$metadata")"
  backup_path="$(validate_backup_path "$backup_path" "$allow_non_volume")"
  prepare_continue "$key_dir" "$backup_path"
}

verify_backup_command() {
  backup_path=""
  allow_non_volume=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --backup-path) backup_path="$2"; shift 2 ;;
      --allow-non-volume-backup) allow_non_volume=1; shift ;;
      *) echo "error: unknown verify-backup option: $1" >&2; exit 2 ;;
    esac
  done
  [ -n "$backup_path" ] || { echo "error: --backup-path is required" >&2; exit 2; }
  ensure_common_tools
  TEMP_ROOT="$(make_temp_root)"
  backup_path="$(validate_backup_path "$backup_path" "$allow_non_volume")"
  "$PYTHON" "$HELPER" verify-checksums --key-dir "$backup_path"
  sign_and_verify "$backup_path/updater.key" "$backup_path/updater.pub" 0
  echo "Backup verified independently: $backup_path"
}

activate_command() {
  key_dir=""
  dry_run=0
  allow_non_volume=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --key-dir) key_dir="$2"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      --allow-non-volume-backup) allow_non_volume=1; shift ;;
      *) echo "error: unknown activate option: $1" >&2; exit 2 ;;
    esac
  done
  [ -n "$key_dir" ] || { echo "error: --key-dir is required" >&2; exit 2; }
  if [ "$dry_run" -eq 1 ]; then
    echo "DRY RUN: would update local public trust files only"
    return
  fi
  ensure_common_tools
  TEMP_ROOT="$(make_temp_root)"
  key_dir="$("$PYTHON" "$HELPER" validate-path \
    --path "$key_dir" --repo-root "$ROOT" --allow-non-volume)"
  "$PYTHON" "$HELPER" verify-checksums --key-dir "$key_dir"
  [ "$(json_value "$key_dir/rotation-state.json" state)" = "complete" ] || {
    echo "error: key preparation journal is not complete" >&2
    exit 1
  }
  backup_path="$(locate_backup_from_metadata "$key_dir/metadata.json")"
  backup_path="$(validate_backup_path "$backup_path" "$allow_non_volume")"
  [ -d "$backup_path" ] || {
    echo "error: recorded updater key backup is unavailable: $backup_path" >&2
    exit 1
  }
  "$PYTHON" "$HELPER" verify-checksums --key-dir "$backup_path"
  [ "$(json_value "$backup_path/rotation-state.json" state)" = "complete" ] || {
    echo "error: backup preparation journal is not complete" >&2
    exit 1
  }
  for name in updater.key updater.key.pub updater.pub metadata.json SHA256SUMS RECOVERY.md rotation-state.json; do
    cmp -s "$key_dir/$name" "$backup_path/$name" || {
      echo "error: primary key and backup differ: $name" >&2
      exit 1
    }
  done
  sign_and_verify "$key_dir/updater.key" "$key_dir/updater.pub" 1
  echo "Existing v0.1.11 clients will not trust this new key."
  echo "The next release must be installed manually as a transition."
  printf 'Type "%s" to continue: ' "$CONFIRM_PHRASE"
  IFS= read -r confirmation
  [ "$confirmation" = "$CONFIRM_PHRASE" ] || {
    echo "error: confirmation phrase did not match" >&2
    exit 1
  }
  SNAPSHOT_DIR="$TEMP_ROOT/public-snapshot"
  "$PYTHON" "$HELPER" snapshot-public-files \
    --repo-root "$ROOT" --snapshot-dir "$SNAPSHOT_DIR"
  TRANSACTION_ACTIVE=1
  previous_b64="$(json_value "$key_dir/metadata.json" previous_public_key_base64)"
  "$PYTHON" "$HELPER" apply-public-files \
    --repo-root "$ROOT" \
    --previous-public-key-b64 "$previous_b64" \
    --target-public-key-file "$key_dir/updater.key.pub"
  if [ "${OPENLOOP_KEY_ROTATION_TESTING:-0}" = "1" ]; then
    ${OPENLOOP_KEY_ROTATION_TEST_GATE:-true}
  else
    cargo test --locked --manifest-path "$VERIFIER_MANIFEST"
    "$ROOT/.venv/bin/pytest" "$ROOT/tests/test_update_release.py" -q
    git -C "$ROOT" diff --check
  fi
  TRANSACTION_ACTIVE=0
  "$PYTHON" "$HELPER" discard-snapshot --snapshot-dir "$SNAPSHOT_DIR"
  echo "Local public key activated. Review, commit, and push before sync-github."
}

sync_bundle_secret() {
  service="$1"
  repo="$2"
  key_dir="${3:-}"
  key_id="${4:-}"
  password="$(security find-generic-password -a "$USER" -s "$service" -w)"
  [ -n "$key_dir" ] && [ -n "$key_id" ] || {
    unset password
    echo "error: key directory and key id are required for Secret sync" >&2
    return 1
  }
  bundle="$(printf '%s' "$password" \
    | "$PYTHON" "$HELPER" build-secret-bundle \
      --key-id "$key_id" \
      --private-key "$key_dir/updater.key")"
  unset password
  [ -n "$bundle" ] || {
    echo "error: signing bundle construction returned no data" >&2
    return 1
  }
  printf '%s' "$bundle" | gh secret set TAURI_SIGNING_BUNDLE --repo "$repo"
  unset bundle
}

sync_github_command() {
  key_dir=""
  remote="origin"
  repo=""
  allow_non_volume=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --key-dir) key_dir="$2"; shift 2 ;;
      --remote) remote="$2"; shift 2 ;;
      --repo) repo="$2"; shift 2 ;;
      --allow-non-volume-backup) allow_non_volume=1; shift ;;
      *) echo "error: unknown sync-github option: $1" >&2; exit 2 ;;
    esac
  done
  [ -n "$key_dir" ] || { echo "error: --key-dir is required" >&2; exit 2; }
  ensure_common_tools
  TEMP_ROOT="$(make_temp_root)"
  key_dir="$("$PYTHON" "$HELPER" validate-path \
    --path "$key_dir" --repo-root "$ROOT" --allow-non-volume)"
  "$PYTHON" "$HELPER" verify-checksums --key-dir "$key_dir"
  [ "$(json_value "$key_dir/rotation-state.json" state)" = "complete" ] || {
    echo "error: key preparation journal is not complete" >&2
    exit 1
  }
  backup_path="$(locate_backup_from_metadata "$key_dir/metadata.json")"
  backup_path="$(validate_backup_path "$backup_path" "$allow_non_volume")"
  "$PYTHON" "$HELPER" verify-checksums --key-dir "$backup_path"
  [ "$(json_value "$backup_path/rotation-state.json" state)" = "complete" ] || {
    echo "error: backup preparation journal is not complete" >&2
    exit 1
  }
  for name in updater.key updater.key.pub updater.pub metadata.json SHA256SUMS RECOVERY.md rotation-state.json; do
    cmp -s "$key_dir/$name" "$backup_path/$name" || {
      echo "error: primary key and backup differ: $name" >&2
      exit 1
    }
  done
  sign_and_verify "$key_dir/updater.key" "$key_dir/updater.pub" 1
  metadata="$key_dir/metadata.json"
  [ -n "$repo" ] || repo="$(json_value "$metadata" repository.name_with_owner)"
  default_branch="$(json_value "$metadata" repository.default_branch)"
  expected_id="$(json_value "$metadata" repository.id)"
  remote_url="$(git -C "$ROOT" remote get-url "$remote")"
  gh repo view "$repo" --json id,nameWithOwner,url,defaultBranchRef > "$TEMP_ROOT/target-raw.json"
  gh repo view "$remote_url" --json id,nameWithOwner,url,defaultBranchRef > "$TEMP_ROOT/remote-raw.json"
  normalize_repository_json "$TEMP_ROOT/target-raw.json" "$TEMP_ROOT/target.json"
  normalize_repository_json "$TEMP_ROOT/remote-raw.json" "$TEMP_ROOT/remote.json"
  "$PYTHON" - "$metadata" "$TEMP_ROOT/metadata-repo.json" <<'PY'
import json, pathlib, sys
metadata = json.loads(pathlib.Path(sys.argv[1]).read_text())
pathlib.Path(sys.argv[2]).write_text(json.dumps(metadata["repository"]) + "\n")
PY
  "$PYTHON" "$HELPER" require-repositories \
    --identity-file "$TEMP_ROOT/metadata-repo.json" \
    --identity-file "$TEMP_ROOT/target.json" \
    --identity-file "$TEMP_ROOT/remote.json"
  target_id="$(json_value "$TEMP_ROOT/target.json" id)"
  remote_id="$(json_value "$TEMP_ROOT/remote.json" id)"
  [ "$expected_id" = "$target_id" ] && [ "$target_id" = "$remote_id" ] || exit 1
  current_default="$(json_value "$TEMP_ROOT/target.json" default_branch)"
  [ "$current_default" = "$default_branch" ] || {
    echo "error: GitHub default branch changed since prepare" >&2
    exit 1
  }
  git -C "$ROOT" fetch --no-tags "$remote" \
    "refs/heads/$default_branch:refs/remotes/$remote/$default_branch"
  fetched_oid="$(git -C "$ROOT" rev-parse "refs/remotes/$remote/$default_branch")"
  remote_oid="$(git -C "$ROOT" ls-remote --heads "$remote_url" "refs/heads/$default_branch" | awk '{print $1}')"
  [ "$fetched_oid" = "$remote_oid" ] || {
    echo "error: fetched default branch is stale" >&2
    exit 1
  }
  remote_root="$TEMP_ROOT/remote"
  for relative in \
    surfaces/gui/src-tauri/tauri.conf.json \
    packaging/openloop-updater.pub \
    packaging/verify_update_release.py \
    packaging/load_updater_signing_bundle.py \
    packaging/build_dmg.sh \
    .github/workflows/release.yml; do
    mkdir -p "$remote_root/$(dirname "$relative")"
    git -C "$ROOT" show "refs/remotes/$remote/$default_branch:$relative" > "$remote_root/$relative"
  done
  "$PYTHON" "$HELPER" verify-remote-files \
    --remote-root "$remote_root" --public-key "$key_dir/updater.pub" \
    --local-root "$ROOT"
  service="OpenLoop Updater Signing Key $(json_value "$metadata" current_key_id)"
  sync_bundle_secret \
    "$service" "$repo" "$key_dir" "$(json_value "$metadata" current_key_id)"
  gh run list --repo "$repo" --workflow release.yml --branch "$default_branch" \
    --event workflow_dispatch --limit 100 --json databaseId > "$TEMP_ROOT/runs-before.json"
  gh workflow run release.yml --repo "$repo" --ref "$default_branch"
  run_id=""
  attempt=0
  while [ "$attempt" -lt 30 ] && [ -z "$run_id" ]; do
    sleep 2
    gh run list --repo "$repo" --workflow release.yml --branch "$default_branch" \
      --event workflow_dispatch --limit 100 \
      --json databaseId,headSha,event > "$TEMP_ROOT/runs-after.json"
    run_id="$("$PYTHON" - "$TEMP_ROOT/runs-before.json" "$TEMP_ROOT/runs-after.json" "$fetched_oid" <<'PY'
import json, pathlib, sys
before = {item["databaseId"] for item in json.loads(pathlib.Path(sys.argv[1]).read_text())}
after = json.loads(pathlib.Path(sys.argv[2]).read_text())
matches = [
    item for item in after
    if item["databaseId"] not in before
    and item.get("headSha") == sys.argv[3]
    and item.get("event") == "workflow_dispatch"
]
if len(matches) > 1:
    raise SystemExit("multiple matching workflow runs appeared")
if matches:
    print(matches[0]["databaseId"])
PY
)"
    attempt=$((attempt + 1))
  done
  [ -n "$run_id" ] || {
    echo "error: no unique workflow run matched verified commit $fetched_oid" >&2
    exit 1
  }
  gh run watch "$run_id" --repo "$repo" --exit-status
  gh run download "$run_id" --repo "$repo" --dir "$TEMP_ROOT/artifacts"
  artifact="$(find "$TEMP_ROOT/artifacts" -name 'OpenLoop-macos-arm64.app.tar.gz' -type f | head -1)"
  signature="$artifact.sig"
  [ -f "$artifact" ] && [ -f "$signature" ] || {
    echo "error: remote challenge did not produce updater artifacts" >&2
    exit 1
  }
  cargo run --quiet --locked --manifest-path "$VERIFIER_MANIFEST" -- \
    "$artifact" "$signature" "$key_dir/updater.pub"
  echo "GitHub signing bundle synchronized and remotely verified."
}

if [ "${OPENLOOP_KEY_ROTATION_SOURCE_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

command="${1:-}"
[ -n "$command" ] || { usage; exit 2; }
shift
case "$command" in
  prepare) prepare_command "$@" ;;
  resume-prepare) resume_prepare_command "$@" ;;
  verify-backup) verify_backup_command "$@" ;;
  activate) activate_command "$@" ;;
  sync-github) sync_github_command "$@" ;;
  -h|--help|help) usage ;;
  *) echo "error: unknown command: $command" >&2; usage >&2; exit 2 ;;
esac
