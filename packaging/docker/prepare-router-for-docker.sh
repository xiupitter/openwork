#!/usr/bin/env bash
# Prepare a Linux opencode-router binary for Docker build.
# Run from repo root. Requires bun and pnpm.
#
# Cross-compilation: on Windows we build for Linux (bun-linux-x64), so the
# binary runs correctly inside the Ubuntu/Debian-based container.
# If you see "Failed to extract executable for 'bun-linux-x64'" on Windows,
# use build-router-in-docker.sh (or .ps1) instead to build inside a Linux container.
#
# Usage (from repo root):
#   ./packaging/docker/prepare-router-for-docker.sh
# On Windows PowerShell use: .\plackaging\docker\prepare-router-for-docker.ps1
#
# Then build the image:
#   docker build -f packaging/docker/Dockerfile.with-router -t openwork-with-router packaging/docker

set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ROUTER_PKG="$REPO_ROOT/packages/opencode-router"
OUT_DIR="$REPO_ROOT/packaging/docker/opencode-router-bin"

case "$(uname -s)" in
  Linux)
    case "$(uname -m)" in
      x86_64|amd64) BUN_TARGET="bun-linux-x64" ;;
      aarch64|arm64) BUN_TARGET="bun-linux-arm64" ;;
      *) echo "Unsupported arch: $(uname -m)" >&2; exit 1 ;;
    esac
    ;;
  Darwin)
    case "$(uname -m)" in
      x86_64) BUN_TARGET="bun-linux-x64" ;;
      arm64)  BUN_TARGET="bun-linux-arm64" ;;
      *) echo "Unsupported arch: $(uname -m)" >&2; exit 1 ;;
    esac
    ;;
  *)
    # Default to linux x64 when building on Windows or other host for Linux container
    BUN_TARGET="bun-linux-x64"
    ;;
esac

echo "[prepare-router] Building opencode-router for $BUN_TARGET..."
cd "$REPO_ROOT"
pnpm --filter opencode-router exec bun ./script/build.ts --outdir dist/bin --filename opencode-router --target "$BUN_TARGET"

SRC="$ROUTER_PKG/dist/bin/opencode-router-$BUN_TARGET"
if [[ "$BUN_TARGET" == *"windows"* ]]; then
  SRC="${SRC}.exe"
fi

if [[ ! -f "$SRC" ]]; then
  echo "Expected binary not found: $SRC" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cp "$SRC" "$OUT_DIR/opencode-router"
chmod +x "$OUT_DIR/opencode-router"
echo "[prepare-router] Copied to $OUT_DIR/opencode-router"
echo "[prepare-router] Build image with: docker build -f packaging/docker/Dockerfile.with-router -t openwork-with-router packaging/docker"
