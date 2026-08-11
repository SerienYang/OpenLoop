from __future__ import annotations

import base64
import hashlib
import io
import json
import pathlib
import plistlib
import stat
import struct
import subprocess
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
VERIFY = ROOT / "packaging" / "verify_update_release.py"
MAKE_MANIFEST = ROOT / "packaging" / "make_update_manifest.py"
PUBLIC_KEY = ROOT / "packaging" / "openloop-updater.pub"
TAURI_CONFIG = ROOT / "surfaces" / "gui" / "src-tauri" / "tauri.conf.json"
EXPECTED_PUBLIC_KEY_SHA256 = (
    "0d3df758365c1731830a8131291d16aee8e0cdd360c686f32d3c9b4f2746de65"
)


def write_macos_archive(
    path: pathlib.Path, *, version: str = "0.1.12", cpu_type: int = 0x0100000C
) -> None:
    plist = plistlib.dumps(
        {
            "CFBundleShortVersionString": version,
            "CFBundleVersion": version,
            "CFBundleExecutable": "openloop-desktop",
        }
    )
    executable = struct.pack("<II", 0xFEEDFACF, cpu_type) + bytes(24)
    with tarfile.open(path, "w:gz") as archive:
        for name, content, mode in (
            ("OpenLoop.app/Contents/Info.plist", plist, 0o644),
            (
                "OpenLoop.app/Contents/MacOS/openloop-desktop",
                executable,
                0o755,
            ),
        ):
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mode = mode
            archive.addfile(info, io.BytesIO(content))


def write_release_fixture(tmp_path: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
    dist = tmp_path / "dist"
    dist.mkdir()
    artifact = dist / "OpenLoop-macos-arm64.app.tar.gz"
    signature = dist / "OpenLoop-macos-arm64.app.tar.gz.sig"
    write_macos_archive(artifact)
    signature.write_text("wrapped-signature\n")
    manifest = dist / "latest.json"
    manifest.write_text(
        json.dumps(
            {
                "version": "0.1.12",
                "notes": "OpenLoop 0.1.12",
                "pub_date": "2026-08-11T00:00:00Z",
                "platforms": {
                    "darwin-aarch64": {
                        "signature": "wrapped-signature",
                        "url": (
                            "https://github.com/SerienYang/OpenLoop/releases/download/"
                            "v0.1.12/OpenLoop-macos-arm64.app.tar.gz"
                        ),
                    }
                },
            }
        )
    )
    verifier = tmp_path / "verifier"
    verifier.write_text("#!/bin/sh\nexit 0\n")
    verifier.chmod(verifier.stat().st_mode | stat.S_IXUSR)
    return dist, verifier


def verify_command(
    dist: pathlib.Path,
    verifier: pathlib.Path,
    *,
    public_key: pathlib.Path = PUBLIC_KEY,
) -> list[str]:
    return [
        sys.executable,
        str(VERIFY),
        "--version",
        "0.1.12",
        "--tag",
        "v0.1.12",
        "--repo",
        "SerienYang/OpenLoop",
        "--dist",
        str(dist),
        "--manifest",
        str(dist / "latest.json"),
        "--required-platform",
        "darwin-aarch64",
        "--verifier",
        str(verifier),
        "--public-key",
        str(public_key),
        "--tauri-config",
        str(TAURI_CONFIG),
    ]


def test_active_updater_public_key_matches_config() -> None:
    key_bytes = PUBLIC_KEY.read_bytes()
    assert hashlib.sha256(key_bytes).hexdigest() == EXPECTED_PUBLIC_KEY_SHA256
    configured = json.loads(TAURI_CONFIG.read_text())["plugins"]["updater"]["pubkey"]
    assert base64.b64decode(configured) == key_bytes


def test_valid_release_fixture_passes_the_orchestrator(tmp_path: pathlib.Path) -> None:
    dist, verifier = write_release_fixture(tmp_path)

    result = subprocess.run(
        verify_command(dist, verifier),
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def test_manifest_signature_drift_is_rejected(tmp_path: pathlib.Path) -> None:
    dist, verifier = write_release_fixture(tmp_path)
    manifest_path = dist / "latest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["platforms"]["darwin-aarch64"]["signature"] = "different"
    manifest_path.write_text(json.dumps(manifest))

    result = subprocess.run(
        verify_command(dist, verifier),
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0


def test_changed_public_key_is_rejected_before_verification(tmp_path: pathlib.Path) -> None:
    dist, verifier = write_release_fixture(tmp_path)
    changed_key = tmp_path / "changed.pub"
    lines = PUBLIC_KEY.read_text().splitlines()
    replacement = "A" if lines[1][0] != "A" else "B"
    lines[1] = replacement + lines[1][1:]
    changed_key.write_text("\n".join(lines) + "\n")

    result = subprocess.run(
        verify_command(dist, verifier, public_key=changed_key),
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0


def test_archive_version_must_match_manifest_version(tmp_path: pathlib.Path) -> None:
    dist, verifier = write_release_fixture(tmp_path)
    write_macos_archive(
        dist / "OpenLoop-macos-arm64.app.tar.gz", version="0.1.11"
    )

    result = subprocess.run(
        verify_command(dist, verifier),
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0


def test_arm64_release_rejects_non_arm64_executable(tmp_path: pathlib.Path) -> None:
    dist, verifier = write_release_fixture(tmp_path)
    write_macos_archive(
        dist / "OpenLoop-macos-arm64.app.tar.gz", cpu_type=0x01000007
    )

    result = subprocess.run(
        verify_command(dist, verifier),
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0


def test_required_platform_missing_from_manifest_generation_fails(
    tmp_path: pathlib.Path,
) -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(MAKE_MANIFEST),
            "--version",
            "0.1.12",
            "--tag",
            "v0.1.12",
            "--repo",
            "SerienYang/OpenLoop",
            "--dist",
            str(tmp_path),
            "--out",
            str(tmp_path / "latest.json"),
            "--required-platform",
            "darwin-aarch64",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert not (tmp_path / "latest.json").exists()


def test_tag_release_is_fail_closed() -> None:
    workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text()
    build_script = (ROOT / "packaging" / "build_dmg.sh").read_text()

    assert "verify_update_release.py" in workflow
    assert "--required-platform darwin-aarch64" in workflow
    assert "no updater signatures" not in workflow
    assert 'rm -f "$UPDATER_ARCHIVE" "$UPDATER_SIGNATURE"' in build_script
    assert "updater archive is older than this build start" in build_script
