#!/usr/bin/env python3
"""Structured helpers for OpenLoop updater key rotation."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import NamedTuple

KEY_ID_RE = re.compile(r"^[0-9A-F]{16}$")
SHA_RE = re.compile(r'(")([0-9a-f]{64})(")')
PUBLIC_FILES = (
    "surfaces/gui/src-tauri/tauri.conf.json",
    "packaging/openloop-updater.pub",
    "packaging/verify_update_release.py",
    "tests/test_update_release.py",
)
JOURNAL_TRANSITIONS = {
    "generated": "keychain_saved",
    "keychain_saved": "backup_copied",
    "backup_copied": "backup_verified",
    "backup_verified": "complete",
}
JOURNAL_ORDER = tuple(JOURNAL_TRANSITIONS) + ("complete",)
KEY_CHECKSUM_FILES = ("updater.key", "updater.key.pub", "updater.pub")


class PublicKeyInfo(NamedTuple):
    key_id: str
    document: bytes
    sha256: str
    base64_value: str


def decode_base64(value: str, label: str) -> bytes:
    try:
        return base64.b64decode(value.strip(), validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError(f"{label} is not valid base64") from error


def inspect_public_key(public_key_base64: str) -> PublicKeyInfo:
    document = decode_base64(public_key_base64, "updater public key")
    try:
        lines = document.decode("utf-8").splitlines()
    except UnicodeDecodeError as error:
        raise ValueError("updater public key is not UTF-8") from error
    if len(lines) != 2:
        raise ValueError("updater public key document must contain exactly two lines")
    key_id = lines[0].rsplit(" ", 1)[-1]
    if not KEY_ID_RE.fullmatch(key_id):
        raise ValueError("updater key id must be 16 uppercase hexadecimal characters")
    normalized = ("\n".join(lines) + "\n").encode()
    return PublicKeyInfo(
        key_id=key_id,
        document=normalized,
        sha256=hashlib.sha256(normalized).hexdigest(),
        base64_value=base64.b64encode(normalized).decode(),
    )


def build_secret_bundle(*, key_id: str, private_key: bytes, password: bytes) -> str:
    if not KEY_ID_RE.fullmatch(key_id):
        raise ValueError("invalid updater key id")
    if password.endswith(b"\n"):
        password = password[:-1]
    if not private_key or not password:
        raise ValueError("private key and password must not be empty")
    if b"\r" in password or b"\n" in password:
        raise ValueError("password must be a single line")
    payload = {
        "key_id": key_id,
        "private_key_base64": base64.b64encode(private_key).decode(),
        "password_base64": base64.b64encode(password).decode(),
    }
    return base64.b64encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    ).decode()


def _existing_ancestors(path: pathlib.Path) -> list[pathlib.Path]:
    existing: list[pathlib.Path] = []
    current = path
    while not current.exists() and current != current.parent:
        current = current.parent
    while True:
        existing.append(current)
        if current == current.parent:
            break
        current = current.parent
    return existing


def validate_safe_path(
    path: pathlib.Path,
    repo_root: pathlib.Path,
    *,
    allow_non_volume: bool = False,
) -> pathlib.Path:
    if ".." in path.parts:
        raise ValueError("path traversal is not allowed")
    absolute = path.expanduser().absolute()
    for component in reversed(_existing_ancestors(absolute)):
        if component.is_symlink():
            raise ValueError(f"symlink path component is not allowed: {component}")
    resolved = absolute.resolve(strict=False)
    repo = repo_root.resolve(strict=True)
    try:
        resolved.relative_to(repo)
    except ValueError:
        pass
    else:
        raise ValueError("key and backup paths must be outside the repository")
    nearest = next(item for item in _existing_ancestors(resolved) if item.exists())
    inside_git = subprocess.run(
        ["git", "-C", str(nearest), "rev-parse", "--is-inside-work-tree"],
        capture_output=True,
        text=True,
        check=False,
    )
    if inside_git.returncode == 0 and inside_git.stdout.strip() == "true":
        raise ValueError("key and backup paths must not be inside any Git worktree")
    if not allow_non_volume and not str(resolved).startswith("/Volumes/"):
        raise ValueError("backup path must be on an external volume under /Volumes")
    return resolved


def _fsync_directory(path: pathlib.Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path: pathlib.Path, content: bytes, mode: int) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.close(descriptor)
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary.unlink(missing_ok=True)


def snapshot_public_files(repo_root: pathlib.Path, snapshot_dir: pathlib.Path) -> None:
    if snapshot_dir.exists():
        raise ValueError("snapshot directory already exists")
    snapshot_dir.mkdir(parents=True, mode=0o700)
    files: dict[str, dict[str, object]] = {}
    for relative in PUBLIC_FILES:
        path = repo_root / relative
        content = path.read_bytes()
        files[relative] = {
            "content_base64": base64.b64encode(content).decode(),
            "mode": stat.S_IMODE(path.stat().st_mode),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
    atomic_write(
        snapshot_dir / "snapshot.json",
        (json.dumps({"files": files}, indent=2, sort_keys=True) + "\n").encode(),
        0o600,
    )


def restore_public_files(repo_root: pathlib.Path, snapshot_dir: pathlib.Path) -> None:
    data = json.loads((snapshot_dir / "snapshot.json").read_text())
    if set(data.get("files", {})) != set(PUBLIC_FILES):
        raise ValueError("snapshot file set is invalid")
    for relative in PUBLIC_FILES:
        entry = data["files"][relative]
        content = decode_base64(entry["content_base64"], f"snapshot {relative}")
        if hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise ValueError(f"snapshot checksum mismatch: {relative}")
        atomic_write(repo_root / relative, content, int(entry["mode"]))


def _replace_active_sha(
    content: str, *, previous_sha: str, target_sha: str, label: str
) -> str:
    matches = list(SHA_RE.finditer(content))
    candidates = [match for match in matches if match.group(2) in {previous_sha, target_sha}]
    if len(candidates) != 1:
        raise ValueError(f"{label} active public key SHA is in an unexpected state")
    match = candidates[0]
    return content[: match.start(2)] + target_sha + content[match.end(2) :]


def apply_public_files(
    repo_root: pathlib.Path,
    *,
    previous_public_key_b64: str,
    target_public_key_b64: str,
) -> None:
    previous = inspect_public_key(previous_public_key_b64)
    target = inspect_public_key(target_public_key_b64)
    config_path = repo_root / PUBLIC_FILES[0]
    public_path = repo_root / PUBLIC_FILES[1]
    verify_path = repo_root / PUBLIC_FILES[2]
    test_path = repo_root / PUBLIC_FILES[3]
    originals = {
        path: (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
        for path in (config_path, public_path, verify_path, test_path)
    }
    try:
        config = json.loads(config_path.read_text())
        current_b64 = config["plugins"]["updater"]["pubkey"]
        if current_b64 not in {previous.base64_value, target.base64_value}:
            raise ValueError("tauri updater public key is in an unexpected third state")
        current_document = public_path.read_bytes()
        if current_document not in {previous.document, target.document}:
            raise ValueError("frozen updater public key is in an unexpected third state")
        config["plugins"]["updater"]["pubkey"] = target.base64_value
        outputs = {
            config_path: (json.dumps(config, indent=2) + "\n").encode(),
            public_path: target.document,
            verify_path: _replace_active_sha(
                verify_path.read_text(),
                previous_sha=previous.sha256,
                target_sha=target.sha256,
                label="release verifier",
            ).encode(),
            test_path: _replace_active_sha(
                test_path.read_text(),
                previous_sha=previous.sha256,
                target_sha=target.sha256,
                label="release test",
            ).encode(),
        }
        for path, content in outputs.items():
            atomic_write(path, content, originals[path][1])
    except Exception:
        for path, (content, mode) in originals.items():
            atomic_write(path, content, mode)
        raise


def require_same_repository(*identities: dict[str, str]) -> None:
    required = {"id", "host", "name_with_owner"}
    normalized = []
    for identity in identities:
        if not required.issubset(identity) or not all(identity[key] for key in required):
            raise ValueError("repository identity is incomplete")
        if not str(identity["id"]).startswith("R_"):
            raise ValueError("repository identity must use the GraphQL id")
        normalized.append(tuple(identity[key] for key in sorted(required)))
    if len(set(normalized)) != 1:
        raise ValueError("repository identities do not match")


def copy_key_directory(source: pathlib.Path, target: pathlib.Path) -> None:
    if target.exists() or target.is_symlink():
        raise ValueError("backup target already exists")
    for item in source.rglob("*"):
        if item.is_symlink():
            raise ValueError(f"key directory contains a symlink: {item}")
    temporary = target.parent / f".{target.name}.partial-{secrets.token_hex(8)}"
    try:
        shutil.copytree(source, temporary, copy_function=shutil.copy2)
        for item in temporary.rglob("*"):
            if item.is_dir():
                item.chmod(0o700)
            elif item.is_file():
                item.chmod(0o600)
                with item.open("rb") as stream:
                    os.fsync(stream.fileno())
        temporary.chmod(0o700)
        _fsync_directory(temporary)
        os.replace(temporary, target)
        _fsync_directory(target.parent)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def write_prepare_context(
    key_dir: pathlib.Path,
    *,
    repository: dict[str, str],
    volume: dict[str, str],
    previous_public_key_b64: str,
    timestamp: str,
) -> None:
    required_repository = {"id", "host", "name_with_owner", "default_branch"}
    required_volume = {"uuid", "mount_root", "base_relative_path"}
    if set(repository) != required_repository or not all(repository.values()):
        raise ValueError("repository prepare context is incomplete")
    if not str(repository["id"]).startswith("R_"):
        raise ValueError("repository prepare context must use the GraphQL id")
    if set(volume) != required_volume or not volume["uuid"] or not volume["mount_root"]:
        raise ValueError("backup volume prepare context is incomplete")
    if not re.fullmatch(r"\d{8}T\d{6}Z", timestamp):
        raise ValueError("prepare timestamp is invalid")
    previous = inspect_public_key(previous_public_key_b64)
    context = {
        "repository": repository,
        "backup_volume_uuid": volume["uuid"],
        "backup_mount_root": volume["mount_root"],
        "backup_base_relative_path": volume["base_relative_path"],
        "previous_public_key_base64": previous.base64_value,
        "timestamp": timestamp,
    }
    atomic_write(
        key_dir / "prepare-context.json",
        (json.dumps(context, indent=2, sort_keys=True) + "\n").encode(),
        0o600,
    )


def discard_prepare_context(key_dir: pathlib.Path) -> None:
    path = key_dir / "prepare-context.json"
    path.unlink(missing_ok=True)
    _fsync_directory(key_dir)


def write_key_metadata(
    key_dir: pathlib.Path,
    *,
    repository: dict[str, str],
    backup_volume_uuid: str,
    backup_relative_path: str,
    previous_public_key_b64: str,
    backup_mount_root: str = "/",
) -> None:
    required_repository = {"id", "host", "name_with_owner", "default_branch"}
    if set(repository) != required_repository or not all(repository.values()):
        raise ValueError("repository metadata is incomplete")
    if not str(repository["id"]).startswith("R_"):
        raise ValueError("repository metadata must use the GraphQL id")
    previous = inspect_public_key(previous_public_key_b64)
    info = inspect_public_key((key_dir / "updater.key.pub").read_text())
    checksums = []
    for name in KEY_CHECKSUM_FILES:
        content = (key_dir / name).read_bytes()
        checksums.append(f"{hashlib.sha256(content).hexdigest()}  {name}")
    metadata = {
        "created_at": __import__("datetime")
        .datetime.now(__import__("datetime").timezone.utc)
        .isoformat(timespec="seconds"),
        "repository": repository,
        "backup_volume_uuid": backup_volume_uuid,
        "backup_mount_root": backup_mount_root,
        "backup_relative_path": backup_relative_path,
        "previous_key_id": previous.key_id,
        "previous_public_key_sha256": previous.sha256,
        "previous_public_key_base64": previous.base64_value,
        "current_key_id": info.key_id,
        "private_key_sha256": hashlib.sha256(
            (key_dir / "updater.key").read_bytes()
        ).hexdigest(),
        "public_key_sha256": info.sha256,
        "manual_transition_required": True,
    }
    atomic_write(
        key_dir / "metadata.json",
        (json.dumps(metadata, indent=2, sort_keys=True) + "\n").encode(),
        0o600,
    )
    atomic_write(
        key_dir / "SHA256SUMS", ("\n".join(checksums) + "\n").encode(), 0o600
    )
    atomic_write(
        key_dir / "RECOVERY.md",
        (
            "# OpenLoop updater key recovery\n\n"
            "This private key is password-encrypted. Recover the password from the "
            "separate password manager entry, then run `verify-backup` before use.\n"
        ).encode(),
        0o600,
    )
    atomic_write(
        key_dir / "rotation-state.json",
        (
            json.dumps(
                {"key_id": info.key_id, "state": "generated"},
                indent=2,
                sort_keys=True,
            )
            + "\n"
        ).encode(),
        0o600,
    )


def advance_journal(key_dir: pathlib.Path, next_state: str) -> None:
    path = key_dir / "rotation-state.json"
    journal = json.loads(path.read_text())
    current = journal.get("state")
    if current not in JOURNAL_ORDER or next_state not in JOURNAL_ORDER:
        raise ValueError(f"unknown journal state: {current} -> {next_state}")
    if JOURNAL_ORDER.index(current) >= JOURNAL_ORDER.index(next_state):
        return
    if JOURNAL_TRANSITIONS.get(current) != next_state:
        raise ValueError(f"invalid journal transition: {current} -> {next_state}")
    journal["state"] = next_state
    atomic_write(
        path, (json.dumps(journal, indent=2, sort_keys=True) + "\n").encode(), 0o600
    )


def verify_key_checksums(
    key_dir: pathlib.Path, *, require_complete: bool = True
) -> bool:
    required_files = (
        "updater.key",
        "updater.key.pub",
        "updater.pub",
        "metadata.json",
        "SHA256SUMS",
        "RECOVERY.md",
        "rotation-state.json",
    )
    for name in required_files:
        path = key_dir / name
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"required key recovery file is missing or unsafe: {name}")
    lines = (key_dir / "SHA256SUMS").read_text().splitlines()
    if not lines:
        raise ValueError("key checksum file is empty")
    entries: dict[str, str] = {}
    for line in lines:
        expected, separator, name = line.partition("  ")
        if (
            not separator
            or pathlib.Path(name).name != name
            or name in entries
            or not re.fullmatch(r"[0-9a-f]{64}", expected)
        ):
            raise ValueError("key checksum manifest is invalid")
        entries[name] = expected
    if set(entries) != set(KEY_CHECKSUM_FILES):
        raise ValueError("key checksum manifest does not cover the expected key files")
    for name in KEY_CHECKSUM_FILES:
        content = (key_dir / name).read_bytes()
        if hashlib.sha256(content).hexdigest() != entries[name]:
            raise ValueError(f"key checksum mismatch: {name}")
    info = inspect_public_key((key_dir / "updater.key.pub").read_text())
    if (key_dir / "updater.pub").read_bytes() != info.document:
        raise ValueError("decoded updater public key does not match its Base64 form")
    metadata = json.loads((key_dir / "metadata.json").read_text())
    if metadata.get("current_key_id") != info.key_id:
        raise ValueError("key metadata current key id does not match")
    if metadata.get("private_key_sha256") != hashlib.sha256(
        (key_dir / "updater.key").read_bytes()
    ).hexdigest():
        raise ValueError("key metadata private key checksum does not match")
    if metadata.get("public_key_sha256") != info.sha256:
        raise ValueError("key metadata public key checksum does not match")
    journal = json.loads((key_dir / "rotation-state.json").read_text())
    if journal.get("key_id") != info.key_id:
        raise ValueError("key journal id does not match")
    if require_complete and journal.get("state") != "complete":
        raise ValueError("key preparation journal is not complete")
    if not (key_dir / "RECOVERY.md").read_text().strip():
        raise ValueError("key recovery instructions are empty")
    return True


def verify_remote_target(
    remote_root: pathlib.Path,
    active_public_key_path: pathlib.Path,
    *,
    local_root: pathlib.Path | None = None,
) -> None:
    public_document = active_public_key_path.read_bytes()
    target = inspect_public_key(base64.b64encode(public_document).decode())
    config = json.loads(
        (remote_root / "surfaces/gui/src-tauri/tauri.conf.json").read_text()
    )
    if config["plugins"]["updater"]["pubkey"] != target.base64_value:
        raise ValueError("remote Tauri config does not contain the target public key")
    if (remote_root / "packaging/openloop-updater.pub").read_bytes() != target.document:
        raise ValueError("remote frozen public key does not match the target")
    if target.sha256 not in (
        remote_root / "packaging/verify_update_release.py"
    ).read_text():
        raise ValueError("remote release verifier does not contain the target SHA")
    loader = (remote_root / "packaging/load_updater_signing_bundle.py").read_text()
    if "UPDATER_SIGNING_BUNDLE" not in loader or "::add-mask::" not in loader:
        raise ValueError("remote signing bundle loader is not active")
    workflow = (remote_root / ".github/workflows/release.yml").read_text()
    if "TAURI_SIGNING_BUNDLE" not in workflow or "load_updater_signing_bundle.py" not in workflow:
        raise ValueError("remote release workflow is not bundle-aware")
    build_script = (remote_root / "packaging/build_dmg.sh").read_text()
    if (
        "TAURI_SIGNING_PRIVATE_KEY_PATH" not in build_script
        or "UPDATER_KEY_AVAILABLE" not in build_script
    ):
        raise ValueError("remote build script does not support updater key paths")
    if local_root is not None:
        for relative in (
            "packaging/verify_update_release.py",
            "packaging/load_updater_signing_bundle.py",
            "packaging/build_dmg.sh",
            ".github/workflows/release.yml",
        ):
            if (remote_root / relative).read_bytes() != (local_root / relative).read_bytes():
                raise ValueError(f"remote release infrastructure differs: {relative}")


def _cli() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect = subparsers.add_parser("inspect-key")
    inspect.add_argument("--public-key-file", required=True, type=pathlib.Path)

    validate = subparsers.add_parser("validate-path")
    validate.add_argument("--path", required=True, type=pathlib.Path)
    validate.add_argument("--repo-root", required=True, type=pathlib.Path)
    validate.add_argument("--allow-non-volume", action="store_true")

    metadata = subparsers.add_parser("write-metadata")
    metadata.add_argument("--key-dir", required=True, type=pathlib.Path)
    metadata.add_argument("--repository-json", required=True, type=pathlib.Path)
    metadata.add_argument("--backup-volume-uuid", required=True)
    metadata.add_argument("--backup-mount-root", required=True)
    metadata.add_argument("--backup-relative-path", required=True)
    metadata.add_argument("--previous-public-key-b64", required=True)

    prepare_context = subparsers.add_parser("write-prepare-context")
    prepare_context.add_argument("--key-dir", required=True, type=pathlib.Path)
    prepare_context.add_argument("--repository-json", required=True, type=pathlib.Path)
    prepare_context.add_argument("--volume-json", required=True, type=pathlib.Path)
    prepare_context.add_argument("--previous-public-key-b64", required=True)
    prepare_context.add_argument("--timestamp", required=True)

    discard_context = subparsers.add_parser("discard-prepare-context")
    discard_context.add_argument("--key-dir", required=True, type=pathlib.Path)

    journal = subparsers.add_parser("advance-journal")
    journal.add_argument("--key-dir", required=True, type=pathlib.Path)
    journal.add_argument("--state", required=True)

    checksums = subparsers.add_parser("verify-checksums")
    checksums.add_argument("--key-dir", required=True, type=pathlib.Path)

    snapshot = subparsers.add_parser("snapshot-public-files")
    snapshot.add_argument("--repo-root", required=True, type=pathlib.Path)
    snapshot.add_argument("--snapshot-dir", required=True, type=pathlib.Path)

    restore = subparsers.add_parser("restore-public-files")
    restore.add_argument("--repo-root", required=True, type=pathlib.Path)
    restore.add_argument("--snapshot-dir", required=True, type=pathlib.Path)

    discard = subparsers.add_parser("discard-snapshot")
    discard.add_argument("--snapshot-dir", required=True, type=pathlib.Path)

    apply_parser = subparsers.add_parser("apply-public-files")
    apply_parser.add_argument("--repo-root", required=True, type=pathlib.Path)
    apply_parser.add_argument("--previous-public-key-b64", required=True)
    apply_parser.add_argument("--target-public-key-file", required=True, type=pathlib.Path)

    bundle = subparsers.add_parser("build-secret-bundle")
    bundle.add_argument("--key-id", required=True)
    bundle.add_argument("--private-key", required=True, type=pathlib.Path)

    remote = subparsers.add_parser("verify-remote-files")
    remote.add_argument("--remote-root", required=True, type=pathlib.Path)
    remote.add_argument("--public-key", required=True, type=pathlib.Path)
    remote.add_argument("--local-root", required=True, type=pathlib.Path)

    copy_directory = subparsers.add_parser("copy-key-directory")
    copy_directory.add_argument("--source", required=True, type=pathlib.Path)
    copy_directory.add_argument("--target", required=True, type=pathlib.Path)

    repositories = subparsers.add_parser("require-repositories")
    repositories.add_argument(
        "--identity-file", action="append", required=True, type=pathlib.Path
    )

    args = parser.parse_args()
    if args.command == "inspect-key":
        info = inspect_public_key(args.public_key_file.read_text())
        print(
            json.dumps(
                {
                    "key_id": info.key_id,
                    "sha256": info.sha256,
                    "base64_value": info.base64_value,
                    "document_base64": base64.b64encode(info.document).decode(),
                },
                sort_keys=True,
            )
        )
    elif args.command == "validate-path":
        print(
            validate_safe_path(
                args.path,
                args.repo_root,
                allow_non_volume=args.allow_non_volume,
            )
        )
    elif args.command == "write-metadata":
        write_key_metadata(
            args.key_dir,
            repository=json.loads(args.repository_json.read_text()),
            backup_volume_uuid=args.backup_volume_uuid,
            backup_mount_root=args.backup_mount_root,
            backup_relative_path=args.backup_relative_path,
            previous_public_key_b64=args.previous_public_key_b64,
        )
    elif args.command == "write-prepare-context":
        write_prepare_context(
            args.key_dir,
            repository=json.loads(args.repository_json.read_text()),
            volume=json.loads(args.volume_json.read_text()),
            previous_public_key_b64=args.previous_public_key_b64,
            timestamp=args.timestamp,
        )
    elif args.command == "discard-prepare-context":
        discard_prepare_context(args.key_dir)
    elif args.command == "advance-journal":
        advance_journal(args.key_dir, args.state)
    elif args.command == "verify-checksums":
        verify_key_checksums(args.key_dir)
    elif args.command == "snapshot-public-files":
        snapshot_public_files(args.repo_root, args.snapshot_dir)
    elif args.command == "restore-public-files":
        restore_public_files(args.repo_root, args.snapshot_dir)
    elif args.command == "discard-snapshot":
        snapshot_file = args.snapshot_dir / "snapshot.json"
        snapshot_file.unlink()
        args.snapshot_dir.rmdir()
    elif args.command == "apply-public-files":
        apply_public_files(
            args.repo_root,
            previous_public_key_b64=args.previous_public_key_b64,
            target_public_key_b64=args.target_public_key_file.read_text(),
        )
    elif args.command == "build-secret-bundle":
        password = sys.stdin.buffer.read()
        sys.stdout.write(
            build_secret_bundle(
                key_id=args.key_id,
                private_key=args.private_key.read_bytes(),
                password=password,
            )
        )
    elif args.command == "verify-remote-files":
        verify_remote_target(
            args.remote_root, args.public_key, local_root=args.local_root
        )
    elif args.command == "copy-key-directory":
        copy_key_directory(args.source, args.target)
    elif args.command == "require-repositories":
        require_same_repository(
            *(json.loads(path.read_text()) for path in args.identity_file)
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(_cli())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
