# Prepare a Linux opencode-router binary for Docker build.
# Run from repo root. Requires bun and pnpm.
#
# On Windows we cross-compile for Linux (bun-linux-x64) so the binary
# runs inside the Ubuntu/Debian-based container.
#
# Usage (from repo root in PowerShell):
#   .\packaging\docker\prepare-router-for-docker.ps1
#
# Then build the image:
#   docker build -f packaging/docker/Dockerfile.with-router -t openwork-with-router packaging/docker

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$RouterPkg = Join-Path $RepoRoot "packages\opencode-router"
$OutDir = Join-Path $RepoRoot "packaging\docker\opencode-router-bin"

# Docker image is Linux amd64; cross-compile for Linux x64 on Windows
$BunTarget = "bun-linux-x64"

Write-Host "[prepare-router] Building opencode-router for $BunTarget..."
Push-Location $RepoRoot
try {
    pnpm --filter opencode-router exec bun ./script/build.ts --outdir dist/bin --filename opencode-router --target $BunTarget
} finally {
    Pop-Location
}

$Src = Join-Path $RouterPkg "dist\bin\opencode-router-$BunTarget"
if (-not (Test-Path $Src)) {
    Write-Error "Expected binary not found: $Src"
    exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Copy-Item -Force $Src (Join-Path $OutDir "opencode-router")
Write-Host "[prepare-router] Copied to $OutDir\opencode-router"
Write-Host "[prepare-router] Build image with: docker build -f packaging/docker/Dockerfile.with-router -t openwork-with-router packaging/docker"
