# opencode-router

Simple Slack + Telegram bridge + directory router for a running `opencode` server.

Runtime requirement: Bun 1.3+ (`bun --version`).

## Install + Run

One-command install (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/different-ai/openwork/dev/packages/opencode-router/install.sh | bash
```

Install from npm:

```bash
npm install -g opencode-router
```

Quick run without global install:

```bash
npx --yes opencode-router --help
```

Then configure identities and start.

1) One-command setup (installs deps, builds, creates `.env` if missing):

```bash
pnpm -C packages/opencode-router setup
```

2) (Optional) Fill in `packages/opencode-router/.env` (see `.env.example`).

Required:
- `OPENCODE_URL`
- `OPENCODE_DIRECTORY`

Recommended:
- `OPENCODE_SERVER_USERNAME`
- `OPENCODE_SERVER_PASSWORD`

3) Run the router:

```bash
opencode-router start
```

## Telegram

Telegram support is configured via identities. You can either:
- Use env vars for a single bot: `TELEGRAM_BOT_TOKEN=...`
  - Or add multiple bots to the config file (`opencode-router.json`) using the CLI:

```bash
opencode-router telegram add <token> --id default
opencode-router telegram list
```

Important for direct sends and bindings:
- Telegram targets must use numeric `chat_id` values.
- `@username` values are not valid direct `peerId` targets for router sends.
- If a user has not started a chat with the bot yet, Telegram may return `chat not found`.
- Private Telegram or DingTalk identities can require first-chat pairing with `/pair <code>` before commands are accepted.

## Slack (Socket Mode)

Slack support uses Socket Mode and replies in threads when @mentioned in channels.

1) Create a Slack app.
2) Enable Socket Mode and generate an app token (`xapp-...`).
3) Add bot token scopes:
   - `chat:write`
   - `app_mentions:read`
   - `im:history`
   - `files:read`
   - `files:write`
4) Subscribe to events (bot events):
   - `app_mention`
   - `message.im`
5) Set env vars (or save via `opencode-router slack add ...`):
    - `SLACK_BOT_TOKEN=xoxb-...`
    - `SLACK_APP_TOKEN=xapp-...`
    - `SLACK_ENABLED=true`

To add multiple Slack apps:

```bash
opencode-router slack add <xoxb> <xapp> --id default
opencode-router slack list
```

## Identity-Scoped Routing

The router routes messages based on `(channel, identityId, peerId) -> directory` bindings.

```bash
opencode-router bindings set --channel telegram --identity default --peer <chatId> --dir /path/to/workdir
opencode-router bindings list
```

## Health Server (Local HTTP)

The router can expose a small local HTTP server for health/config and simple message dispatch.

- `OPENCODE_ROUTER_HEALTH_PORT` controls the port (OpenWork defaults to a random free port when using `openwork`).
- `PORT` is also accepted as a convenience if the above are unset.
- `OPENCODE_ROUTER_HEALTH_HOST` controls bind host (default: `127.0.0.1`).

Send a message to all peers bound to a directory:

```bash
curl -sS "http://127.0.0.1:${OPENCODE_ROUTER_HEALTH_PORT:-3005}/send" \
  -H 'Content-Type: application/json' \
  -d '{"channel":"telegram","directory":"/path/to/workdir","text":"hello"}'
```

Send text + media in one request:

```bash
curl -sS "http://127.0.0.1:${OPENCODE_ROUTER_HEALTH_PORT:-3005}/send" \
  -H 'Content-Type: application/json' \
  -d '{
    "channel":"slack",
    "peerId":"D12345678",
    "text":"Here is the export",
    "parts":[
      {"type":"file","filePath":"./artifacts/report.pdf"},
      {"type":"image","filePath":"./artifacts/plot.png","caption":"latest trend"}
    ]
  }'
```

Supported media part types:
- `image`
- `audio`
- `file`

Each media part accepts:
- `filePath` (absolute path, or relative to the send directory/workspace root)
- optional `caption`
- optional `filename`
- optional `mimeType`

## Commands

```bash
opencode-router start
opencode-router status

opencode-router telegram list
opencode-router telegram add <token> --id default

opencode-router slack list
opencode-router slack add <xoxb> <xapp> --id default

opencode-router bindings list
opencode-router bindings set --channel telegram --identity default --peer <chatId> --dir /path/to/workdir

opencode-router send --channel telegram --identity default --to <chatId> --message "hello"
opencode-router send --channel telegram --identity default --to <chatId> --image ./plot.png --caption "plot"
opencode-router send --channel slack --identity default --to D123 --file ./report.pdf
```

## Defaults

- SQLite at `~/.openwork/opencode-router/opencode-router.db` unless overridden.
- Config stored at `~/.openwork/opencode-router/opencode-router.json` (created by `opencode-router` or `pnpm -C packages/opencode-router setup`).
- Group chats are disabled unless `GROUPS_ENABLED=true`.

## Debugging (DingTalk / 本地调试)

### 1. 环境与配置

- 在 `packages/opencode-router` 下复制 `.env.example` 为 `.env`，至少配置：
  - `OPENCODE_URL`、`OPENCODE_DIRECTORY`（必填）
  - DingTalk：`DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET`（钉钉应用机器人 Stream 模式），或通过 CLI 添加：
    ```bash
    opencode-router dingtalk add <clientId> <clientSecret> --id default
    ```
- 可选：`LOG_LEVEL=debug` 便于看收发与文件相关日志。

### 2. 启动方式

**开发直接跑（改代码即生效）：**

```bash
cd packages/opencode-router
pnpm dev
```

即执行 `bun src/cli.ts`，无需先 build。

**或先编译再启动：**

```bash
cd packages/opencode-router
pnpm build
opencode-router start
```

### 3. VS Code 断点调试

仓库已配置 `.vscode/launch.json`：

- **Debug opencode-router (launch)**：用 Node 调试器 + Bun 运行 `start`，可设断点、查看变量。
- **Debug opencode-router (Bun 扩展)**：若安装了 Bun 扩展，可直接用该配置启动。

操作：在 VS Code 里打开 `packages/opencode-router/src/dingtalk.ts`，在以下位置设断点后按 F5 选上述任一配置启动：

- 入站文件：`downloadDingTalkFile`、`parseRobotMessage` 里解析 `media` 处、回调里 `onMessage({ parts })` 前。
- 出站文件：`uploadDingTalkMedia`、`sendMessageInternal` 里处理 `part.type === "image"` 的分支。

### 4. 验证 DingTalk 文件能力

- **入站（用户发文件给机器人）**：与机器人单聊（群聊 @ 不支持文件），发一张图或一个文件，看控制台/日志里是否有 “dingtalk stream event received” 及后续下载日志；若开了 OpenWork，会话里应出现附件摘要。
- **出站（机器人发文件给用户）**：用健康检查接口发一张图（需先有 session，即用户先给机器人发过一条消息）：
  ```bash
  curl -sS "http://127.0.0.1:3005/send" -H 'Content-Type: application/json' \
    -d '{"channel":"dingtalk","directory":"/path/to/bound/workdir","text":"附图","parts":[{"type":"image","filePath":"/absolute/path/to/image.png"}]}'
  ```
  或通过 OpenWork 的发送能力发到已绑定目录的 DingTalk 会话。

## Tests

`test:smoke` requires a running `opencode` server (default: `http://127.0.0.1:4096`).

```bash
opencode serve --port 4096 --hostname 127.0.0.1
pnpm -C packages/opencode-router test:smoke
```

Other test suites:

```bash
pnpm -C packages/opencode-router test:unit
pnpm -C packages/opencode-router test:cli
pnpm -C packages/opencode-router test:npx
```
