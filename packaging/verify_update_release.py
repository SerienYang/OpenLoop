#!/usr/bin/env python3
"""Fail-closed validation for OpenLoop updater release artifacts."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import pathlib
import plistlib
import struct
import subprocess
import sys
import tarfile

EXPECTED_PUBLIC_KEY_SHA256 = (
    "0d3df758365c1731830a8131291d16aee8e0cdd360c686f32d3c9b4f2746de65"
)
PLATFORMS = {
    "darwin-aarch64": "OpenLoop-macos-arm64.app.tar.gz",
    "darwin-x86_64": "OpenLoop-macos-x64.app.tar.gz",
    "windows-x86_64": "OpenLoop-windows-setup.exe",
}
MACHO_64_MAGIC = 0xFEEDFACF
CPU_TYPE_ARM64 = 0x0100000C
CPU_TYPE_X86_64 = 0x01000007


def fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 1


def verify_macos_archive(
    archive_path: pathlib.Path, *, version: str, cpu_type: int
) -> str | None:
    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            members = archive.getmembers()
            plist_member = next(
                (
                    member
                    for member in members
                    if member.isfile()
                    and member.name.endswith(".app/Contents/Info.plist")
                ),
                None,
            )
            if plist_member is None:
                return "macOS updater archive has no app Info.plist"
            plist_file = archive.extractfile(plist_member)
            if plist_file is None:
                return "could not read app Info.plist from updater archive"
            info = plistlib.loads(plist_file.read())
            if info.get("CFBundleShortVersionString") != version:
                return "app short version does not match the release version"
            if str(info.get("CFBundleVersion")) != version:
                return "app bundle version does not match the release version"
            executable_name = info.get("CFBundleExecutable")
            if not isinstance(executable_name, str) or not executable_name:
                return "app Info.plist has no CFBundleExecutable"
            executable_member = next(
                (
                    member
                    for member in members
                    if member.isfile()
                    and member.name.endswith(
                        f".app/Contents/MacOS/{executable_name}"
                    )
                ),
                None,
            )
            if executable_member is None:
                return "macOS updater archive has no declared app executable"
            executable_file = archive.extractfile(executable_member)
            if executable_file is None:
                return "could not read app executable from updater archive"
            header = executable_file.read(8)
            if len(header) != 8:
                return "app executable has a truncated Mach-O header"
            magic, actual_cpu_type = struct.unpack("<II", header)
            if magic != MACHO_64_MAGIC:
                return "app executable is not a thin 64-bit Mach-O"
            if actual_cpu_type != cpu_type:
                return "app executable architecture does not match the release platform"
    except (OSError, tarfile.TarError, plistlib.InvalidFileException) as error:
        return f"could not inspect macOS updater archive: {error}"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--dist", required=True, type=pathlib.Path)
    parser.add_argument("--manifest", required=True, type=pathlib.Path)
    parser.add_argument("--required-platform", action="append", required=True)
    parser.add_argument("--verifier", required=True, type=pathlib.Path)
    parser.add_argument(
        "--public-key",
        type=pathlib.Path,
        default=pathlib.Path("packaging/openloop-updater.pub"),
    )
    parser.add_argument(
        "--tauri-config",
        type=pathlib.Path,
        default=pathlib.Path("surfaces/gui/src-tauri/tauri.conf.json"),
    )
    args = parser.parse_args()

    key_bytes = args.public_key.read_bytes()
    if hashlib.sha256(key_bytes).hexdigest() != EXPECTED_PUBLIC_KEY_SHA256:
        return fail("updater public key does not match the current active key")

    config = json.loads(args.tauri_config.read_text())
    configured_key = config["plugins"]["updater"]["pubkey"]
    try:
        decoded_key = base64.b64decode(configured_key, validate=True)
    except ValueError:
        return fail("tauri updater public key is not valid base64")
    if decoded_key != key_bytes:
        return fail("tauri updater public key differs from the current active public key")

    if not args.manifest.is_file():
        return fail(f"missing updater manifest: {args.manifest}")
    manifest = json.loads(args.manifest.read_text())
    if manifest.get("version") != args.version:
        return fail("manifest version does not match the release version")
    platforms = manifest.get("platforms")
    if not isinstance(platforms, dict):
        return fail("manifest platforms must be an object")

    for platform in args.required_platform:
        asset = PLATFORMS.get(platform)
        if asset is None:
            return fail(f"unsupported required platform: {platform}")
        artifact = args.dist / asset
        signature = args.dist / f"{asset}.sig"
        if not artifact.is_file() or not signature.is_file():
            return fail(f"missing updater artifact or signature for {platform}")
        if platform == "darwin-aarch64":
            archive_error = verify_macos_archive(
                artifact, version=args.version, cpu_type=CPU_TYPE_ARM64
            )
            if archive_error:
                return fail(archive_error)
        elif platform == "darwin-x86_64":
            archive_error = verify_macos_archive(
                artifact, version=args.version, cpu_type=CPU_TYPE_X86_64
            )
            if archive_error:
                return fail(archive_error)
        entry = platforms.get(platform)
        if not isinstance(entry, dict):
            return fail(f"manifest is missing required platform {platform}")
        expected_url = (
            f"https://github.com/{args.repo}/releases/download/{args.tag}/{asset}"
        )
        if entry.get("url") != expected_url:
            return fail(f"manifest URL mismatch for {platform}")
        signature_text = signature.read_text().strip()
        if entry.get("signature") != signature_text:
            return fail(f"manifest signature mismatch for {platform}")
        result = subprocess.run(
            [str(args.verifier), str(artifact), str(signature), str(args.public_key)],
            check=False,
        )
        if result.returncode != 0:
            return fail(f"cryptographic signature verification failed for {platform}")

    print(
        f"verified updater release {args.version} "
        f"({', '.join(args.required_platform)})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
