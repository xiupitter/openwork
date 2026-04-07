# Build opencode-router Linux binary inside a Docker container.
# Use this when cross-compilation on Windows fails (e.g. "Failed to extract
# executable for 'bun-linux-x64'").
#
# Run from repo root. Requires Docker. No bun/pnpm on host needed.
#
# Usage (from repo root in PowerShell):
#   .\packaging\docker\build-router-in-docker.ps1
#
# Then build the image:
#   docker build -f packaging/docker/Dockerfile.with-router -t openwork-with-router packaging/docker

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$OutDir = Join-Path $RepoRoot "packaging\docker\opencode-router-bin"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "[build-router-in-docker] Building opencode-router inside Linux container..."

 # Important:
 # - Do pnpm install inside container filesystem (/tmp/app), not on the bind-mounted /app.
 # - Some Windows/Docker FS setups can fail pnpm's atomic rename inside node_modules with ERR_PNPM_EACCES.
 $cmd = 'apt-get update -qq && apt-get install -y -qq curl unzip tar && curl -fsSL https://bun.sh/install | bash && export BUN_INSTALL="$HOME/.bun" && export PATH="$BUN_INSTALL/bin:$PATH" && corepack enable && corepack prepare pnpm@10.27.0 --activate && mkdir -p /tmp/app && tar --exclude=node_modules --exclude=.git -cf - -C /app . | tar -xf - -C /tmp/app && cd /tmp/app && pnpm install && cd packages/opencode-router && bun run script/build.ts --outdir dist/bin --filename opencode-router && cp dist/bin/opencode-router /out/opencode-router'
docker run --rm -e CI=true -v "${RepoRoot}:/app" -v "${OutDir}:/out" -w /app node:22-bookworm-slim sh -c $cmd

Write-Host "[build-router-in-docker] Binary copied to $OutDir\opencode-router"
Write-Host "[build-router-in-docker] Build image with: docker build -f packaging/docker/Dockerfile.with-router -t openwork-with-router packaging/docker"
