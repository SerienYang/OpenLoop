#!/usr/bin/env python3
"""Load a single OpenLoop updater signing bundle inside GitHub Actions."""

from __future__ import annotations

import base64
import binascii
import json
import os
import pathlib
import re
import stat
import sys
import tempfile

SCHEMA = {"key_id", "private_key_base64", "password_base64"}
KEY_ID_RE = re.compile(r"^[0-9A-F]{16}$")


def fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 1


def decode_base64(value: str, label: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError(f"{label} is not valid base64") from error


def public_key_id(path: pathlib.Path) -> str:
    first_line = path.read_text(encoding="utf-8").splitlines()[0]
    value = first_line.rsplit(" ", 1)[-1]
    if not KEY_ID_RE.fullmatch(value):
        raise ValueError("checked-in updater public key has an invalid key id")
    return value


def mask_escape(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def write_private_key(directory: pathlib.Path, content: bytes) -> pathlib.Path:
    descriptor, name = tempfile.mkstemp(
        prefix="openloop-updater.", suffix=".key", dir=directory
    )
    path = pathlib.Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ValueError("runner private key permissions are not 0600")
    return path


def main() -> int:
    bundle_value = os.environ.get("UPDATER_SIGNING_BUNDLE")
    github_env = os.environ.get("GITHUB_ENV")
    runner_temp = os.environ.get("RUNNER_TEMP")
    public_key_path = os.environ.get(
        "UPDATER_PUBLIC_KEY_PATH", "packaging/openloop-updater.pub"
    )
    if not bundle_value or not github_env or not runner_temp:
        return fail("required GitHub Actions updater environment is missing")

    try:
        bundle_bytes = decode_base64(bundle_value, "signing bundle")
        payload = json.loads(bundle_bytes.decode("utf-8"))
        if not isinstance(payload, dict) or set(payload) != SCHEMA:
            raise ValueError("signing bundle schema is invalid")
        if not all(isinstance(payload[key], str) for key in SCHEMA):
            raise ValueError("signing bundle fields must be strings")
        expected_key_id = public_key_id(pathlib.Path(public_key_path))
        if payload["key_id"] != expected_key_id:
            raise ValueError("signing bundle key id does not match the active public key")
        private_key = decode_base64(
            payload["private_key_base64"], "private key"
        )
        password_bytes = decode_base64(payload["password_base64"], "password")
        private_text = private_key.decode("utf-8")
        password = password_bytes.decode("utf-8")
        if not private_key or not password:
            raise ValueError("private key and password must not be empty")
        if "\r" in password or "\n" in password:
            raise ValueError("password must be a single line")

        for sensitive in (
            payload["private_key_base64"],
            payload["password_base64"],
            private_text,
            password,
        ):
            print(f"::add-mask::{mask_escape(sensitive)}")
        sys.stdout.flush()

        key_directory = pathlib.Path(runner_temp)
        key_directory.mkdir(parents=True, exist_ok=True)
        key_path = write_private_key(key_directory, private_key)
        with pathlib.Path(github_env).open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(f"TAURI_SIGNING_PRIVATE_KEY_PATH={key_path}\n")
            stream.write(f"TAURI_SIGNING_PRIVATE_KEY_PASSWORD={password}\n")
            stream.flush()
            os.fsync(stream.fileno())
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        return fail(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
