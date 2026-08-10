#requires -Version 5.1
<#
.SYNOPSIS
  Build the OpenLoop Windows desktop app + NSIS (.exe) and MSI installers.

.DESCRIPTION
  The Windows counterpart to build_dmg.sh:
    1. PyInstaller-bundle the server into a standalone onedir folder (no venv at runtime).
    2. Stage it at binaries\sidecar\ for Tauri's `resources` slot.
    3. `tauri build --bundles nsis,msi` -> OpenLoop NSIS setup .exe + .msi (resources copied in).

  Prerequisites (see the toolchain notes in the PR/plan):
    - Rust (rustup) with the x86_64-pc-windows-msvc target + the MSVC C++ build tools (link.exe).
    - Node + npm (frontend build).
    - A frozen Python environment at platform\.venv:
        uv sync --frozen --extra messaging --extra browser --extra bedrock --extra release

  The result is UNSIGNED — first launch shows a SmartScreen warning ("More info" -> "Run anyway").
  Authenticode signing is a later step.

  Experimental (use-at-your-own-risk) connectors are EXCLUDED from this build by default —
  the spec strips the experimental connector package. Self-builders can opt in with:
    $env:OPENLOOP_EXPERIMENTAL = "1"; .\build_windows.ps1
#>
[CmdletBinding()]
param(
    # Which installer bundles to produce. Both by default.
    [string]$Bundles = "nsis,msi"
)
$ErrorActionPreference = "Stop"

$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Platform = Split-Path -Parent $Here
$Gui      = Join-Path $Platform "surfaces\gui"
$Venv     = Join-Path $Platform ".venv"
$PyInst   = Join-Path $Venv "Scripts\pyinstaller.exe"

function Require-Cmd($name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "Required tool '$name' not found on PATH. See the prerequisites in this script's header."
    }
}

Require-Cmd rustc
Require-Cmd npm
if (-not (Test-Path $PyInst)) {
    throw "PyInstaller not found at $PyInst. Create the venv and install deps (see header)."
}

# Host target triple, e.g. x86_64-pc-windows-msvc — Tauri's externalBin suffix.
$Triple = (& rustc -vV | Select-String '^host:').ToString().Split()[-1]
$Arch   = $Triple.Split('-')[0]

# A running sidecar locks the output exe and makes PyInstaller's overwrite fail.
$running = @(Get-Process -Name "openloop-server" -ErrorAction SilentlyContinue)
if ($running) {
    Write-Host "==> stopping $($running.Count) running sidecar process(es) holding the output exe"
    $running | Stop-Process -Force
    Start-Sleep -Seconds 1
}

Write-Host "==> [1/3] PyInstaller: bundling openloop-server ($Triple)" -ForegroundColor Cyan
& $PyInst --noconfirm --clean `
    --distpath (Join-Path $Here "dist") --workpath (Join-Path $Here "build") `
    (Join-Path $Here "openloop-server.spec")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed (exit $LASTEXITCODE)" }

Write-Host "==> [2/3] staging sidecar resources" -ForegroundColor Cyan
# Onedir bundle (exe + _internal\) ships via Tauri `resources`, landing at <install>\sidecar\
# next to the app exe — onefile's per-launch self-extraction cost seconds of boot splash.
$BinDir = Join-Path $Gui "src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Src = Join-Path $Here "dist\openloop-server"
$Dst = Join-Path $BinDir "sidecar"
if (Test-Path $Dst) { Remove-Item -Recurse -Force $Dst }
# Clear any stale onefile binary from pre-onedir builds.
Remove-Item -Force (Join-Path $BinDir "openloop-server-$Triple.exe") -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force $Src $Dst
Write-Host "    -> $Dst"

Write-Host "==> [3/3] tauri build (--bundles $Bundles)" -ForegroundColor Cyan
# Auto-update artifacts (NSIS setup .exe + minisign .sig): produced only when the updater
# signing key env is present (CI secret TAURI_SIGNING_PRIVATE_KEY). Keyless builds skip
# the overlay so dev builds keep working; keyless RELEASES strand installs without
# auto-update.
$UpdaterArgs = @()
if ($env:TAURI_SIGNING_PRIVATE_KEY) {
    # Pass the overlay as a FILE: inline JSON loses its quotes through the
    # PowerShell -> npm.cmd -> cmd hop ("key must be a string", v0.1.3 run).
    $Overlay = Join-Path ([IO.Path]::GetTempPath()) "openloop-updater-overlay.json"
    Set-Content -Path $Overlay -Value '{"bundle":{"createUpdaterArtifacts":true}}' -Encoding ascii
    $UpdaterArgs = @("--config", $Overlay)
} else {
    Write-Host "    WARNING: no updater signing key - building WITHOUT auto-update artifacts (not releasable)." -ForegroundColor Yellow
}
Push-Location $Gui
try {
    & npm run tauri build -- --bundles $Bundles @UpdaterArgs
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }
}
finally {
    Pop-Location
}

$BundleDir = Join-Path $Gui "src-tauri\target\release\bundle"
Write-Host ""
Write-Host "Done. Installers under: $BundleDir" -ForegroundColor Green
Get-ChildItem -Path $BundleDir -Recurse -Include *.exe, *.msi -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "  $($_.FullName)" }
