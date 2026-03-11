# OpenWork Host (Docker)

## Dev testability stack (recommended for testing)

One command, no custom Dockerfile. Uses `node:22-bookworm-slim` off the shelf.

From the repo root:

```bash
./packaging/docker/dev-up.sh
```

Then open the printed Web UI URL (ports are randomized so you can run multiple stacks).

What it does:
- Starts **headless** (OpenCode + OpenWork server) on port 8787
- Starts **web UI** (Vite dev server) on port 5173
- Auto-generates and shares auth tokens between services
- Web waits for headless health check before starting
- Builds Linux binaries inside the container (no host binary conflicts)
- Auto-mounts host OpenCode config/auth into the stack when present, with safe empty-dir fallback

Useful commands:
- Logs: `docker compose -p <project> -f packaging/docker/docker-compose.dev.yml logs`
- Tear down: `docker compose -p <project> -f packaging/docker/docker-compose.dev.yml down`
- Health check: `curl http://localhost:<openwork_port>/health`

Optional env vars (via `.env` or `export`):
- `OPENWORK_TOKEN` — fixed client token
- `OPENWORK_HOST_TOKEN` — fixed host/admin token
- `OPENWORK_WORKSPACE` — host path to mount as workspace
- `OPENWORK_PORT` — host port to map to container :8787
- `WEB_PORT` — host port to map to container :5173
- `OPENWORK_OPENCODE_CONFIG_DIR` — override host OpenCode config dir mount source
- `OPENWORK_OPENCODE_DATA_DIR` — override host OpenCode data dir mount source

---

## Production container

This is a minimal packaging template to run the OpenWork Host contract in a single container.

It runs:

- `opencode serve` (engine) bound to `127.0.0.1:4096` inside the container
- `openwork-server` bound to `0.0.0.0:8787` (the only published surface)

### Local run (compose)

From this directory:

```bash
docker compose up --build
```

Then open:

- `http://127.0.0.1:8787/ui`

### Config

Recommended env vars:

- `OPENWORK_TOKEN` (client token)
- `OPENWORK_HOST_TOKEN` (host/owner token)

Optional:

- `OPENWORK_APPROVAL_MODE=auto|manual`
- `OPENWORK_APPROVAL_TIMEOUT_MS=30000`

Persistence:

- Workspace is mounted at `/workspace`
- Host data dir is mounted at `/data` (OpenCode caches + OpenWork server config/tokens)

### Notes

- OpenCode is not exposed directly; access it via the OpenWork proxy (`/opencode/*`).
- For PaaS, replace `./workspace:/workspace` with a volume or a checkout strategy (git clone on boot).

---

## Production image with opencode-router

To run the host **with** opencode-router (Slack/Telegram/DingTalk bridge), use the image built from `Dockerfile.with-router`. The router binary is **not** built inside Docker; you build it on the host and place it in the build context.

### 1. Build opencode-router for Linux (on your machine)

From the **repo root**:

**Linux / macOS / Git Bash (Windows):**
```bash
./packaging/docker/prepare-router-for-docker.sh
```

**Windows (PowerShell):**
```powershell
.\packaging\docker\prepare-router-for-docker.ps1
```

If on Windows you see **"Failed to extract executable for 'bun-linux-x64'"** (Bun cross-compile download issue), build inside Docker instead (no bun on host needed):

```powershell
.\packaging\docker\build-router-in-docker.ps1
```

Or in Git Bash: `./packaging/docker/build-router-in-docker.sh`

This produces the Linux binary at `packaging/docker/opencode-router-bin/opencode-router`.

To build for a specific Linux target (e.g. amd64 on an arm Mac):

```bash
cd packages/opencode-router
pnpm exec bun ./script/build.ts --outdir dist/bin --filename opencode-router --target bun-linux-x64
mkdir -p ../../packaging/docker/opencode-router-bin
cp dist/bin/opencode-router-bun-linux-x64 ../../packaging/docker/opencode-router-bin/opencode-router
```

### 2. Build the Docker image

Build context must be `packaging/docker` so that `opencode-router-bin/opencode-router` is found:

```bash
docker build -f packaging/docker/Dockerfile.with-router -t openwork-with-router packaging/docker
```

### 3. Run

Use the same `docker-compose.yml` pattern but with image `openwork-with-router` and expose port 3005 if you need the router health endpoint:

```bash
docker run -p 8787:8787 -p 3005:3005 -v $(pwd)/workspace:/workspace -v $(pwd)/data:/data openwork-with-router
```

Or add a `docker-compose.with-router.yml` that uses `Dockerfile.with-router` and includes the router port.
