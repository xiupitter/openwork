#!/usr/bin/env bash
# Build opencode-router Linux binary inside a Docker container.
# Use this when cross-compilation on Windows fails (e.g. "Failed to extract
# executable for 'bun-linux-x64'").
#
# Run from repo root. Requires Docker. No bun/pnpm on host needed.
#
# Usage:
#   ./packaging/docker/build-router-in-docker.sh
#
# Then build the image:
#   docker build -f packaging/docker/Dockerfile.with-router -t openwork-with-router packaging/docker

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$REPO_ROOT/packaging/docker/opencode-router-bin"

mkdir -p "$OUT_DIR"

echo "[build-router-in-docker] Building opencode-router inside Linux container..."
docker run --rm \
  -e CI=true \
  -v "$REPO_ROOT:/app" \
  -v "$OUT_DIR:/out" \
  -w /app \
  node:22-bookworm-slim \
  sh -c 'apt-get update -qq && apt-get install -y -qq curl unzip && curl -fsSL https://bun.sh/install | bash && export BUN_INSTALL="$HOME/.bun" && export PATH="$BUN_INSTALL/bin:$PATH" && corepack enable && corepack prepare pnpm@latest --activate && pnpm install && cd packages/opencode-router && bun run script/build.ts --outdir dist/bin --filename opencode-router && cp dist/bin/opencode-router /out/opencode-router'

echo "[build-router-in-docker] Binary copied to $OUT_DIR/opencode-router"
echo "[build-router-in-docker] Build image with: docker build -f packaging/docker/Dockerfile.with-router -t openwork-with-router packaging/docker"
