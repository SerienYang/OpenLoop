from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import sys
import importlib.util
import shutil

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOADER = ROOT / "packaging" / "load_updater_signing_bundle.py"
PUBLIC_KEY = ROOT / "packaging" / "openloop-updater.pub"
ROTATION_HELPER = ROOT / "packaging" / "updater_key_rotation.py"
ROTATION_SCRIPT = ROOT / "packaging" / "rotate_updater_key.sh"
ACTIVE_PUBLIC_SHA = hashlib.sha256(PUBLIC_KEY.read_bytes()).hexdigest()
ACTIVE_PUBLIC_B64 = json.loads(
    (ROOT / "surfaces/gui/src-tauri/tauri.conf.json").read_text()
)["plugins"]["updater"]["pubkey"]
NEW_PUBLIC_B64 = (
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEYwRjZEQTkxQURDNDdENT"
    "MKUldSVGZjU3RrZHIyOElhdkYraXlWVkU5RUg0Z2ppUjQ0ZzJlbXg5SzdGcWRxQWlBSnV5eH"
    "ViZWkK"
)


def load_rotation_helper():
    spec = importlib.util.spec_from_file_location(
        "updater_key_rotation", ROTATION_HELPER
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def key_id(public_key: pathlib.Path = PUBLIC_KEY) -> str:
    first = public_key.read_text().splitlines()[0]
    return first.rsplit(" ", 1)[-1]


def signing_bundle(
    *,
    private_key: bytes = b"private-key-material\n",
    password: bytes = b"p%ass",
    extra: dict[str, str] | None = None,
) -> str:
    payload: dict[str, str] = {
        "key_id": key_id(),
        "private_key_base64": base64.b64encode(private_key).decode(),
        "password_base64": base64.b64encode(password).decode(),
    }
    if extra:
        payload.update(extra)
    return base64.b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode()


def run_loader(
    tmp_path: pathlib.Path,
    *,
    bundle: str | None = None,
    include_env_file: bool = True,
) -> subprocess.CompletedProcess[str]:
    runner_temp = tmp_path / "runner"
    runner_temp.mkdir()
    env_file = tmp_path / "github-env"
    env = os.environ.copy()
    env.update(
        {
            "UPDATER_SIGNING_BUNDLE": bundle or signing_bundle(),
            "RUNNER_TEMP": str(runner_temp),
            "UPDATER_PUBLIC_KEY_PATH": str(PUBLIC_KEY),
        }
    )
    if include_env_file:
        env["GITHUB_ENV"] = str(env_file)
    else:
        env.pop("GITHUB_ENV", None)
    return subprocess.run(
        [sys.executable, str(LOADER)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_bundle_loader_masks_then_preserves_private_key_bytes(
    tmp_path: pathlib.Path,
) -> None:
    private_key = b"private%key\r\nwith-newline\n"
    password = b"p%ass"

    result = run_loader(
        tmp_path,
        bundle=signing_bundle(private_key=private_key, password=password),
    )

    assert result.returncode == 0, result.stderr
    lines = result.stdout.splitlines()
    assert lines
    assert all(line.startswith("::add-mask::") for line in lines)
    assert "%25" in result.stdout
    assert "%0D%0A" in result.stdout
    env_values = dict(
        line.split("=", 1)
        for line in (tmp_path / "github-env").read_text().splitlines()
    )
    key_path = pathlib.Path(env_values["TAURI_SIGNING_PRIVATE_KEY_PATH"])
    assert key_path.read_bytes() == private_key
    assert stat.S_IMODE(key_path.stat().st_mode) == 0o600
    assert env_values["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"] == password.decode()


@pytest.mark.parametrize(
    "bundle",
    [
        signing_bundle(extra={"unexpected": "value"}),
        "not-base64",
        signing_bundle(password=b""),
        signing_bundle(password=b"line1\nline2"),
        base64.b64encode(
            json.dumps(
                {
                    "key_id": "0000000000000000",
                    "private_key_base64": base64.b64encode(b"key\n").decode(),
                    "password_base64": base64.b64encode(b"password").decode(),
                }
            ).encode()
        ).decode(),
    ],
)
def test_bundle_loader_rejects_invalid_input(
    tmp_path: pathlib.Path, bundle: str
) -> None:
    result = run_loader(tmp_path, bundle=bundle)
    assert result.returncode != 0


def test_bundle_loader_requires_github_env(tmp_path: pathlib.Path) -> None:
    result = run_loader(tmp_path, include_env_file=False)
    assert result.returncode != 0


def test_bundle_loader_does_not_follow_predictable_symlink(
    tmp_path: pathlib.Path,
) -> None:
    runner = tmp_path / "runner"
    runner.mkdir()
    sentinel = tmp_path / "sentinel"
    sentinel.write_text("keep")
    (runner / "openloop-updater.key").symlink_to(sentinel)
    env_file = tmp_path / "github-env"
    env = os.environ.copy()
    env.update(
        {
            "UPDATER_SIGNING_BUNDLE": signing_bundle(),
            "RUNNER_TEMP": str(runner),
            "UPDATER_PUBLIC_KEY_PATH": str(PUBLIC_KEY),
            "GITHUB_ENV": str(env_file),
        }
    )

    result = subprocess.run(
        [sys.executable, str(LOADER)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    key_path = pathlib.Path(
        dict(line.split("=", 1) for line in env_file.read_text().splitlines())[
            "TAURI_SIGNING_PRIVATE_KEY_PATH"
        ]
    )
    assert key_path != runner / "openloop-updater.key"
    assert sentinel.read_text() == "keep"


def test_workflow_and_build_script_use_single_bundle_path_contract() -> None:
    workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text()
    build_script = (ROOT / "packaging" / "build_dmg.sh").read_text()

    assert "TAURI_SIGNING_BUNDLE" in workflow
    assert "load_updater_signing_bundle.py" in workflow
    assert "secrets.TAURI_SIGNING_PRIVATE_KEY }}" not in workflow
    assert "secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}" not in workflow
    assert "TAURI_SIGNING_PRIVATE_KEY_PATH" in build_script
    assert "UPDATER_KEY_AVAILABLE" in build_script
    assert (
        'export TAURI_SIGNING_PRIVATE_KEY="$TAURI_SIGNING_PRIVATE_KEY_PATH"'
        in build_script
    )


def test_rotation_helper_decodes_public_key_and_builds_bundle() -> None:
    helper = load_rotation_helper()

    info = helper.inspect_public_key(NEW_PUBLIC_B64)
    bundle = helper.build_secret_bundle(
        key_id=info.key_id,
        private_key=b"private\n",
        password=b"password",
    )
    payload = json.loads(base64.b64decode(bundle))

    assert info.key_id == "F0F6DA91ADC47D53"
    assert info.document.startswith(b"untrusted comment: minisign public key")
    assert payload["key_id"] == info.key_id
    assert base64.b64decode(payload["private_key_base64"]) == b"private\n"
    assert base64.b64decode(payload["password_base64"]) == b"password"

    newline_bundle = helper.build_secret_bundle(
        key_id=info.key_id,
        private_key=b"private\n",
        password=b"password\n",
    )
    newline_payload = json.loads(base64.b64decode(newline_bundle))
    assert base64.b64decode(newline_payload["password_base64"]) == b"password"


def test_safe_path_rejects_repo_and_symlink(tmp_path: pathlib.Path) -> None:
    helper = load_rotation_helper()
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    link = tmp_path / "link"
    link.symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError):
        helper.validate_safe_path(repo / "keys", repo, allow_non_volume=True)
    with pytest.raises(ValueError):
        helper.validate_safe_path(link / "keys", repo, allow_non_volume=True)
    assert (
        helper.validate_safe_path(outside / "keys", repo, allow_non_volume=True)
        == outside / "keys"
    )


def copy_public_files(destination: pathlib.Path) -> None:
    paths = [
        "surfaces/gui/src-tauri/tauri.conf.json",
        "packaging/openloop-updater.pub",
        "packaging/verify_update_release.py",
        "tests/test_update_release.py",
    ]
    for relative in paths:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, target)


def test_public_file_transaction_updates_and_restores_exact_bytes(
    tmp_path: pathlib.Path,
) -> None:
    helper = load_rotation_helper()
    repo = tmp_path / "repo"
    copy_public_files(repo)
    tracked = helper.PUBLIC_FILES
    before = {
        relative: (
            (repo / relative).read_bytes(),
            stat.S_IMODE((repo / relative).stat().st_mode),
        )
        for relative in tracked
    }
    snapshot = tmp_path / "snapshot"

    helper.snapshot_public_files(repo, snapshot)
    helper.apply_public_files(
        repo,
        previous_public_key_b64=json.loads(
            (repo / "surfaces/gui/src-tauri/tauri.conf.json").read_text()
        )["plugins"]["updater"]["pubkey"],
        target_public_key_b64=NEW_PUBLIC_B64,
    )

    assert (
        json.loads((repo / "surfaces/gui/src-tauri/tauri.conf.json").read_text())[
            "plugins"
        ]["updater"]["pubkey"]
        == NEW_PUBLIC_B64
    )
    helper.restore_public_files(repo, snapshot)
    for relative, (content, mode) in before.items():
        assert (repo / relative).read_bytes() == content
        assert stat.S_IMODE((repo / relative).stat().st_mode) == mode


def test_public_file_transaction_rejects_third_state(tmp_path: pathlib.Path) -> None:
    helper = load_rotation_helper()
    repo = tmp_path / "repo"
    copy_public_files(repo)
    config_path = repo / "surfaces/gui/src-tauri/tauri.conf.json"
    config = json.loads(config_path.read_text())
    previous = config["plugins"]["updater"]["pubkey"]
    config["plugins"]["updater"]["pubkey"] = "third-state"
    config_path.write_text(json.dumps(config))

    with pytest.raises(ValueError):
        helper.apply_public_files(
            repo,
            previous_public_key_b64=previous,
            target_public_key_b64=NEW_PUBLIC_B64,
        )


def test_public_file_transaction_rejects_consistent_third_key_state(
    tmp_path: pathlib.Path,
) -> None:
    helper = load_rotation_helper()
    repo = tmp_path / "repo"
    copy_public_files(repo)
    config_path = repo / "surfaces/gui/src-tauri/tauri.conf.json"
    config = json.loads(config_path.read_text())
    previous = config["plugins"]["updater"]["pubkey"]
    third_document = (
        "untrusted comment: minisign public key: 1111111111111111\n"
        "RWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n"
    ).encode()
    third_b64 = base64.b64encode(third_document).decode()
    third_sha = hashlib.sha256(third_document).hexdigest()
    config["plugins"]["updater"]["pubkey"] = third_b64
    config_path.write_text(json.dumps(config))
    (repo / "packaging/openloop-updater.pub").write_bytes(third_document)
    for relative in (
        "packaging/verify_update_release.py",
        "tests/test_update_release.py",
    ):
        path = repo / relative
        path.write_text(
            path.read_text().replace(ACTIVE_PUBLIC_SHA, third_sha)
        )

    with pytest.raises(ValueError):
        helper.apply_public_files(
            repo,
            previous_public_key_b64=previous,
            target_public_key_b64=NEW_PUBLIC_B64,
        )


def test_repository_identity_requires_graphql_id_host_and_name() -> None:
    helper = load_rotation_helper()
    expected = {
        "id": "R_kgDOT0SokQ",
        "host": "github.com",
        "name_with_owner": "SerienYang/OpenLoop",
    }
    helper.require_same_repository(expected, dict(expected), dict(expected))

    changed = dict(expected, id="R_other")
    with pytest.raises(ValueError):
        helper.require_same_repository(expected, changed, expected)


def test_metadata_journal_and_checksums_are_resumable(tmp_path: pathlib.Path) -> None:
    helper = load_rotation_helper()
    key_dir = tmp_path / ".partial-F0F6DA91ADC47D53"
    key_dir.mkdir(mode=0o700)
    (key_dir / "updater.key").write_bytes(b"private\n")
    (key_dir / "updater.key.pub").write_text(NEW_PUBLIC_B64)
    (key_dir / "updater.pub").write_bytes(
        helper.inspect_public_key(NEW_PUBLIC_B64).document
    )
    repository = {
        "id": "R_kgDOT0SokQ",
        "host": "github.com",
        "name_with_owner": "SerienYang/OpenLoop",
        "default_branch": "main",
    }

    helper.write_key_metadata(
        key_dir,
        repository=repository,
        backup_volume_uuid="TEST-VOLUME",
        backup_relative_path="OpenLoop/backup",
        previous_public_key_b64=ACTIVE_PUBLIC_B64,
    )
    helper.advance_journal(key_dir, "keychain_saved")
    helper.advance_journal(key_dir, "backup_copied")

    assert helper.verify_key_checksums(key_dir, require_complete=False)
    metadata = json.loads((key_dir / "metadata.json").read_text())
    assert metadata["current_key_id"] == "F0F6DA91ADC47D53"
    assert metadata["manual_transition_required"] is True
    assert json.loads((key_dir / "rotation-state.json").read_text())["state"] == "backup_copied"
    with pytest.raises(ValueError):
        helper.advance_journal(key_dir, "complete")


def test_remote_target_requires_all_release_trust_files(
    tmp_path: pathlib.Path,
) -> None:
    helper = load_rotation_helper()
    remote = tmp_path / "remote"
    copy_public_files(remote)
    (remote / "packaging/load_updater_signing_bundle.py").write_text(
        "UPDATER_SIGNING_BUNDLE\n::add-mask::\n"
    )
    (remote / ".github/workflows").mkdir(parents=True)
    (remote / ".github/workflows/release.yml").write_text(
        "TAURI_SIGNING_BUNDLE\nload_updater_signing_bundle.py\n"
    )
    (remote / "packaging/build_dmg.sh").write_text(
        "TAURI_SIGNING_PRIVATE_KEY_PATH\nUPDATER_KEY_AVAILABLE\n"
    )

    helper.verify_remote_target(remote, PUBLIC_KEY, local_root=remote)
    (remote / "packaging/build_dmg.sh").write_text("old")
    with pytest.raises(ValueError):
        helper.verify_remote_target(remote, PUBLIC_KEY, local_root=remote)


def test_key_directory_copy_is_atomic_and_rejects_existing_target(
    tmp_path: pathlib.Path,
) -> None:
    helper = load_rotation_helper()
    source = tmp_path / "source"
    source.mkdir()
    (source / "updater.key").write_bytes(b"private\n")
    target = tmp_path / "backup"

    helper.copy_key_directory(source, target)

    assert (target / "updater.key").read_bytes() == b"private\n"
    assert not list(tmp_path.glob(".backup.partial-*"))
    with pytest.raises(ValueError):
        helper.copy_key_directory(source, target)


@pytest.mark.parametrize(
    "missing_name",
    ("metadata.json", "SHA256SUMS", "RECOVERY.md", "rotation-state.json"),
)
def test_complete_key_verification_rejects_missing_recovery_file(
    tmp_path: pathlib.Path,
    missing_name: str,
) -> None:
    helper = load_rotation_helper()
    key_dir = tmp_path / "key"
    key_dir.mkdir()
    (key_dir / "updater.key").write_bytes(b"private\n")
    (key_dir / "updater.key.pub").write_text(NEW_PUBLIC_B64)
    (key_dir / "updater.pub").write_bytes(
        helper.inspect_public_key(NEW_PUBLIC_B64).document
    )
    helper.write_key_metadata(
        key_dir,
        repository={
            "id": "R_kgDOT0SokQ",
            "host": "github.com",
            "name_with_owner": "SerienYang/OpenLoop",
            "default_branch": "main",
        },
        backup_volume_uuid="TEST-VOLUME",
        backup_relative_path="backup",
        previous_public_key_b64=ACTIVE_PUBLIC_B64,
    )
    for state in ("keychain_saved", "backup_copied", "backup_verified", "complete"):
        helper.advance_journal(key_dir, state)
    (key_dir / missing_name).unlink()

    with pytest.raises((OSError, ValueError)):
        helper.verify_key_checksums(key_dir)


def test_complete_key_verification_requires_all_key_checksum_entries(
    tmp_path: pathlib.Path,
) -> None:
    helper = load_rotation_helper()
    key_dir = tmp_path / "key"
    key_dir.mkdir()
    (key_dir / "updater.key").write_bytes(b"private\n")
    (key_dir / "updater.key.pub").write_text(NEW_PUBLIC_B64)
    (key_dir / "updater.pub").write_bytes(
        helper.inspect_public_key(NEW_PUBLIC_B64).document
    )
    helper.write_key_metadata(
        key_dir,
        repository={
            "id": "R_kgDOT0SokQ",
            "host": "github.com",
            "name_with_owner": "SerienYang/OpenLoop",
            "default_branch": "main",
        },
        backup_volume_uuid="TEST-VOLUME",
        backup_relative_path="backup",
        previous_public_key_b64=ACTIVE_PUBLIC_B64,
    )
    for state in ("keychain_saved", "backup_copied", "backup_verified", "complete"):
        helper.advance_journal(key_dir, state)
    checksum_path = key_dir / "SHA256SUMS"
    checksum_path.write_text(
        "\n".join(
            line
            for line in checksum_path.read_text().splitlines()
            if not line.endswith("  updater.key.pub")
        )
        + "\n"
    )

    with pytest.raises(ValueError, match="checksum manifest"):
        helper.verify_key_checksums(key_dir)


def test_rotation_script_has_safe_shell_contract() -> None:
    result = subprocess.run(
        ["/bin/bash", "-n", str(ROTATION_SCRIPT)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    source = ROTATION_SCRIPT.read_text()
    assert "signer generate --ci" not in source
    assert "--password" not in source
    assert "set -Eeuo pipefail" in source
    assert "/private/tmp/openloop-updater-key" not in source
    assert "stat -f %u" not in source
    activate = source.split("activate_command()", 1)[1].split(
        "sync_bundle_secret()", 1
    )[0]
    assert "gh " not in activate
    assert 'sign_and_verify "$key_dir/updater.key"' in activate
    assert 'cmp -s "$key_dir/$name"' in activate
    assert "rotation-state.json" in activate


def test_non_volume_override_is_supported_by_recovery_commands() -> None:
    source = ROTATION_SCRIPT.read_text()
    usage = source.split("usage()", 1)[1].split("cleanup()", 1)[0]
    assert (
        "verify-backup --backup-path PATH [--allow-non-volume-backup]" in usage
    )
    assert "activate --key-dir PATH [--allow-non-volume-backup]" in usage
    assert (
        "sync-github --key-dir PATH [--remote origin] [--repo OWNER/REPO] "
        "[--allow-non-volume-backup]" in usage
    )
    for start, end in (
        ("verify_backup_command()", "activate_command()"),
        ("activate_command()", "sync_bundle_secret()"),
        ("sync_github_command()", 'if [ "${OPENLOOP_KEY_ROTATION_SOURCE_ONLY'),
    ):
        section = source.split(start, 1)[1].split(end, 1)[0]
        assert "--allow-non-volume-backup" in section
        assert 'validate_backup_path "$backup_path" "$allow_non_volume"' in section


def test_rotation_script_dry_run_has_no_side_effects(tmp_path: pathlib.Path) -> None:
    backup = tmp_path / "backup"
    backup.mkdir()
    key_root = tmp_path / "keys"
    env = os.environ.copy()
    env["OPENLOOP_KEY_ROTATION_TESTING"] = "1"

    result = subprocess.run(
        [
            "/bin/bash",
            str(ROTATION_SCRIPT),
            "prepare",
            "--backup-dir",
            str(backup),
            "--key-root",
            str(key_root),
            "--allow-non-volume-backup",
            "--dry-run",
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert not key_root.exists()
    assert list(backup.iterdir()) == []
    assert "DRY RUN" in result.stdout


def write_executable(path: pathlib.Path, content: str) -> None:
    path.write_text(content)
    path.chmod(0o755)


def test_volume_details_supports_local_apfs_logical_paths(
    tmp_path: pathlib.Path,
) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    write_executable(
        fake_bin / "df",
        """#!/bin/bash
cat <<'EOF'
Filesystem 512-blocks Used Available Capacity Mounted on
/dev/disk3s1 1 1 1 1% /System/Volumes/Data
EOF
""",
    )
    write_executable(
        fake_bin / "diskutil",
        """#!/bin/bash
cat <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>MountPoint</key><string>/System/Volumes/Data</string>
<key>VolumeUUID</key><string>LOCAL-DATA-UUID</string>
</dict></plist>
EOF
""",
    )
    output = tmp_path / "volume.json"
    temp_root = tmp_path / "temp"
    temp_root.mkdir()
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "OPENLOOP_KEY_ROTATION_SOURCE_ONLY": "1",
            "OPENLOOP_KEY_ROTATION_PYTHON": sys.executable,
        }
    )

    result = subprocess.run(
        [
            "/bin/bash",
            "-c",
            (
                f"source '{ROTATION_SCRIPT}'; "
                f"TEMP_ROOT='{temp_root}'; "
                f"volume_details '/Users/example/OpenLoop-Backup' '{output}'"
            ),
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(output.read_text()) == {
        "uuid": "LOCAL-DATA-UUID",
        "mount_root": "/",
        "base_relative_path": "Users/example/OpenLoop-Backup",
    }


def test_locate_backup_uses_recorded_non_volume_mount_root(
    tmp_path: pathlib.Path,
) -> None:
    backup = tmp_path / "OpenLoop" / "key-backup"
    backup.mkdir(parents=True)
    metadata = tmp_path / "metadata.json"
    metadata.write_text(
        json.dumps(
            {
                "backup_volume_uuid": "LOCAL-DATA-UUID",
                "backup_mount_root": str(tmp_path),
                "backup_relative_path": "OpenLoop/key-backup",
            }
        )
    )
    temp_root = tmp_path / "temp"
    temp_root.mkdir()
    env = os.environ.copy()
    env.update(
        {
            "OPENLOOP_KEY_ROTATION_SOURCE_ONLY": "1",
            "OPENLOOP_KEY_ROTATION_PYTHON": sys.executable,
        }
    )

    result = subprocess.run(
        [
            "/bin/bash",
            "-c",
            (
                f"source '{ROTATION_SCRIPT}'; "
                f"TEMP_ROOT='{temp_root}'; "
                "volume_uuid_for_path() { printf 'LOCAL-DATA-UUID\\n'; }; "
                f"locate_backup_from_metadata '{metadata}'"
            ),
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert pathlib.Path(result.stdout.strip()) == backup


def test_prepare_with_fake_tools_creates_primary_and_backup(
    tmp_path: pathlib.Path,
) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    staging_path_log = tmp_path / "staging-path.log"
    write_executable(
        fake_bin / "npm",
        f"""#!/bin/bash
set -eu
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--write-keys" ]; then output="$2"; shift 2; else shift; fi
done
[ -n "$output" ]
printf '%s\\n' "$output" > '{staging_path_log}'
printf 'encrypted-private\\n' > "$output"
printf '%s\\n' '{NEW_PUBLIC_B64}' > "$output.pub"
""",
    )
    write_executable(fake_bin / "security", "#!/bin/bash\nexit 0\n")
    write_executable(fake_bin / "cargo", "#!/bin/bash\nexit 0\n")
    write_executable(
        fake_bin / "gh",
        """#!/bin/bash
cat <<'JSON'
{"id":"R_kgDOT0SokQ","nameWithOwner":"SerienYang/OpenLoop","url":"https://github.com/SerienYang/OpenLoop","defaultBranchRef":{"name":"main"}}
JSON
""",
    )
    backup = tmp_path / "backup"
    backup.mkdir()
    key_root = tmp_path / "keys"
    env = os.environ.copy()
    env.update(
        {
            "OPENLOOP_KEY_ROTATION_TESTING": "1",
            "PATH": f"{fake_bin}:{env['PATH']}",
        }
    )

    result = subprocess.run(
        [
            "/bin/bash",
            str(ROTATION_SCRIPT),
            "prepare",
            "--backup-dir",
            str(backup),
            "--key-root",
            str(key_root),
            "--allow-non-volume-backup",
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    primary = key_root / "F0F6DA91ADC47D53"
    assert primary.is_dir()
    assert json.loads((primary / "rotation-state.json").read_text())["state"] == "complete"
    backups = list(backup.glob("OpenLoop-updater-F0F6DA91ADC47D53-*"))
    assert len(backups) == 1
    assert (backups[0] / "updater.key").read_bytes() == b"encrypted-private\n"
    assert json.loads((backups[0] / "rotation-state.json").read_text())["state"] == "complete"
    assert "encrypted-private" not in result.stdout + result.stderr
    staged_key = pathlib.Path(staging_path_log.read_text().strip())
    assert staged_key.is_relative_to(key_root)
    assert not list(key_root.glob(".partial-pending.*"))


def test_prepare_uses_tmpdir_for_temp_root(
    tmp_path: pathlib.Path,
) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    temp_root = tmp_path / "runner-temp"
    temp_root.mkdir()
    template_log = tmp_path / "mktemp-template.log"
    write_executable(
        fake_bin / "mktemp",
        f"""#!/bin/bash
set -eu
[ "$1" = "-d" ]
template="$2"
printf '%s\\n' "$template" >> '{template_log}'
prefix="${{template%XXXXXX}}"
case "$template" in
  "$TMPDIR"/openloop-updater-key.XXXXXX|*/.partial-pending.XXXXXX)
    target="${{prefix}}TDD123"
    mkdir -p "$target"
    printf '%s\\n' "$target"
    ;;
  *)
    echo "unexpected template: $template" >&2
    exit 17
    ;;
esac
""",
    )
    write_executable(
        fake_bin / "npm",
        f"""#!/bin/bash
set -eu
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--write-keys" ]; then output="$2"; shift 2; else shift; fi
done
[ -n "$output" ]
printf 'encrypted-private\\n' > "$output"
printf '%s\\n' '{NEW_PUBLIC_B64}' > "$output.pub"
""",
    )
    write_executable(fake_bin / "security", "#!/bin/bash\nexit 0\n")
    write_executable(fake_bin / "cargo", "#!/bin/bash\nexit 0\n")
    write_executable(
        fake_bin / "gh",
        """#!/bin/bash
cat <<'JSON'
{"id":"R_kgDOT0SokQ","nameWithOwner":"SerienYang/OpenLoop","url":"https://github.com/SerienYang/OpenLoop","defaultBranchRef":{"name":"main"}}
JSON
""",
    )
    backup = tmp_path / "backup"
    backup.mkdir()
    key_root = tmp_path / "keys"
    env = os.environ.copy()
    env.update(
        {
            "OPENLOOP_KEY_ROTATION_TESTING": "1",
            "TMPDIR": str(temp_root),
            "PATH": f"{fake_bin}:{env['PATH']}",
        }
    )

    result = subprocess.run(
        [
            "/bin/bash",
            str(ROTATION_SCRIPT),
            "prepare",
            "--backup-dir",
            str(backup),
            "--key-root",
            str(key_root),
            "--allow-non-volume-backup",
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert template_log.read_text().splitlines()[0] == str(
        temp_root / "openloop-updater-key.XXXXXX"
    )


def test_prepare_failure_after_generation_preserves_same_key_for_resume(
    tmp_path: pathlib.Path,
) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    write_executable(
        fake_bin / "npm",
        f"""#!/bin/bash
set -eu
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--write-keys" ]; then output="$2"; shift 2; else shift; fi
done
[ -n "$output" ]
printf 'encrypted-private\\n' > "$output"
printf '%s\\n' '{NEW_PUBLIC_B64}' > "$output.pub"
exit 9
""",
    )
    write_executable(fake_bin / "security", "#!/bin/bash\nexit 0\n")
    write_executable(fake_bin / "cargo", "#!/bin/bash\nexit 0\n")
    write_executable(
        fake_bin / "gh",
        """#!/bin/bash
cat <<'JSON'
{"id":"R_kgDOT0SokQ","nameWithOwner":"SerienYang/OpenLoop","url":"https://github.com/SerienYang/OpenLoop","defaultBranchRef":{"name":"main"}}
JSON
""",
    )
    backup = tmp_path / "backup"
    backup.mkdir()
    key_root = tmp_path / "keys"
    env = os.environ.copy()
    env.update(
        {
            "OPENLOOP_KEY_ROTATION_TESTING": "1",
            "OPENLOOP_KEY_ROTATION_TEST_VOLUME_ROOT": str(backup),
            "PATH": f"{fake_bin}:{env['PATH']}",
        }
    )

    result = subprocess.run(
        [
            "/bin/bash",
            str(ROTATION_SCRIPT),
            "prepare",
            "--backup-dir",
            str(backup),
            "--key-root",
            str(key_root),
            "--allow-non-volume-backup",
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 9
    pending = list(key_root.glob(".partial-pending.*"))
    assert len(pending) == 1
    assert (pending[0] / "updater.key").read_bytes() == b"encrypted-private\n"
    assert f"resume-prepare --key-dir {pending[0]}" in result.stderr

    write_executable(fake_bin / "npm", "#!/bin/bash\nexit 0\n")
    resumed = subprocess.run(
        [
            "/bin/bash",
            str(ROTATION_SCRIPT),
            "resume-prepare",
            "--key-dir",
            str(pending[0]),
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert resumed.returncode == 0, resumed.stderr
    primary = key_root / "F0F6DA91ADC47D53"
    assert (primary / "updater.key").read_bytes() == b"encrypted-private\n"
    assert not list(key_root.glob(".partial-pending.*"))


def test_advance_journal_is_idempotent_for_resume(tmp_path: pathlib.Path) -> None:
    helper = load_rotation_helper()
    key_dir = tmp_path / "key"
    key_dir.mkdir()
    (key_dir / "rotation-state.json").write_text(
        '{"key_id":"F0F6DA91ADC47D53","state":"generated"}\n'
    )

    helper.advance_journal(key_dir, "keychain_saved")
    helper.advance_journal(key_dir, "keychain_saved")
    helper.advance_journal(key_dir, "backup_copied")
    helper.advance_journal(key_dir, "backup_verified")
    helper.advance_journal(key_dir, "backup_copied")

    assert json.loads((key_dir / "rotation-state.json").read_text())["state"] == "backup_verified"


def test_failed_keychain_lookup_never_invokes_gh_secret_set(
    tmp_path: pathlib.Path,
) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    gh_log = tmp_path / "gh.log"
    write_executable(fake_bin / "security", "#!/bin/bash\nexit 9\n")
    write_executable(
        fake_bin / "gh",
        f"#!/bin/bash\nprintf called >> '{gh_log}'\nexit 0\n",
    )
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "OPENLOOP_KEY_ROTATION_SOURCE_ONLY": "1",
        }
    )

    result = subprocess.run(
        [
            "/bin/bash",
            "-c",
            f"source '{ROTATION_SCRIPT}'; sync_bundle_secret test-service test/repo",
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert not gh_log.exists()


def test_empty_keychain_password_never_invokes_signer(
    tmp_path: pathlib.Path,
) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    npm_log = tmp_path / "npm.log"
    write_executable(fake_bin / "security", "#!/bin/bash\nexit 0\n")
    write_executable(
        fake_bin / "npm",
        f"#!/bin/bash\nprintf called > '{npm_log}'\nexit 0\n",
    )
    write_executable(fake_bin / "cargo", "#!/bin/bash\nexit 0\n")
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "OPENLOOP_KEY_ROTATION_SOURCE_ONLY": "1",
        }
    )

    result = subprocess.run(
        [
            "/bin/bash",
            "-c",
            (
                f"source '{ROTATION_SCRIPT}'; "
                f"TEMP_ROOT='{tmp_path}'; "
                f"sign_and_verify '{tmp_path / 'updater.key'}' '{PUBLIC_KEY}' 1"
            ),
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "password must not be empty" in result.stderr
    assert not npm_log.exists()


def test_activate_gate_failure_restores_existing_worktree_bytes(
    tmp_path: pathlib.Path,
) -> None:
    helper = load_rotation_helper()
    repo = tmp_path / "repo"
    copy_public_files(repo)
    before = {
        relative: (repo / relative).read_bytes() for relative in helper.PUBLIC_FILES
    }
    volume_root = tmp_path / "volume"
    backup_relative = "OpenLoop/key-backup"
    key_dir = tmp_path / "keys" / "F0F6DA91ADC47D53"
    key_dir.mkdir(parents=True, mode=0o700)
    (key_dir / "updater.key").write_bytes(b"private\n")
    (key_dir / "updater.key.pub").write_text(NEW_PUBLIC_B64)
    (key_dir / "updater.pub").write_bytes(
        helper.inspect_public_key(NEW_PUBLIC_B64).document
    )
    helper.write_key_metadata(
        key_dir,
        repository={
            "id": "R_kgDOT0SokQ",
            "host": "github.com",
            "name_with_owner": "SerienYang/OpenLoop",
            "default_branch": "main",
        },
        backup_volume_uuid="TEST-VOLUME",
        backup_relative_path=backup_relative,
        previous_public_key_b64=ACTIVE_PUBLIC_B64,
    )
    for state in ("keychain_saved", "backup_copied", "backup_verified", "complete"):
        helper.advance_journal(key_dir, state)
    backup = volume_root / backup_relative
    backup.parent.mkdir(parents=True)
    shutil.copytree(key_dir, backup)
    env = os.environ.copy()
    env.update(
        {
            "OPENLOOP_KEY_ROTATION_TESTING": "1",
            "OPENLOOP_KEY_ROTATION_REPO_ROOT": str(repo),
            "OPENLOOP_KEY_ROTATION_PYTHON": sys.executable,
            "OPENLOOP_KEY_ROTATION_TEST_VOLUME_ROOT": str(volume_root),
            "OPENLOOP_KEY_ROTATION_TEST_GATE": "false",
        }
    )

    result = subprocess.run(
        [
            "/bin/bash",
            str(ROTATION_SCRIPT),
            "activate",
            "--key-dir",
            str(key_dir),
        ],
        input="ROTATE OPENLOOP UPDATER KEY\n",
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    for relative, content in before.items():
        assert (repo / relative).read_bytes() == content


def test_term_signal_returns_143_instead_of_success() -> None:
    env = os.environ.copy()
    env["OPENLOOP_KEY_ROTATION_SOURCE_ONLY"] = "1"
    result = subprocess.run(
        [
            "/bin/bash",
            "-c",
            f"source '{ROTATION_SCRIPT}'; on_terminate",
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 143
