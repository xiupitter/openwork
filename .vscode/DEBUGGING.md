# 在 Cursor/VS Code 中调试 OpenWork

## 关于「Failed to start debugger. Program could not be started」

在 Windows 上，**Bun 官方扩展** 的 launch 有已知问题（权限/Unix socket），会报上述错误，目前建议不要依赖「Debug opencode-router (Bun 扩展)」，改用下面两种方式之一。

## 推荐方式（Windows 下任选其一）

### 1. Web 调试器（推荐，断点可靠）

1. **先启动带调试端口的进程**（二选一）：
   - 在 Cursor 里按 `Ctrl+Shift+P` → 输入 **“任务: 运行任务”** → 选 **「opencode-router: start with inspect」**；或
   - 在终端执行：
     ```bash
     cd packages/opencode-router && bun --inspect=127.0.0.1:9229 src/cli.ts start
     ```
2. 浏览器打开 **https://debug.bun.sh**，连接 `127.0.0.1:9229`。
3. 在网页里对 `bridge.ts`、`cli.ts` 等源码下断点、单步、查看变量。

### 2. Attach（先启动再附加）

1. 运行任务 **「opencode-router: start with inspect」**（或上面终端命令）。
2. 在调试下拉选 **「Attach to opencode-router (manual)”**，按 F5。
3. 若断点不命中（Bun 用 WebKit 协议，Node 调试器可能不兼容），请改用方式 1。

## 任务说明

- **opencode-router: start with inspect**：在 9229 端口以调试模式启动 opencode-router，供 Web 调试器或 Attach 使用。

---

## 为什么在 debug.bun.sh 里有些代码“没解析到”、变量看不到？

常见原因和应对：

1. **Bun 把变量内联掉了**  
   旧版本 Bun 在调试时会把部分变量内联优化，导致调试器里看不到。**请把 Bun 升级到 1.1.35 及以上**（[issue #9343](https://github.com/oven-sh/bun/issues/9343) 已修）。  
   检查版本：`bun --version`；升级：`bun upgrade` 或重装。

2. **部分源码/作用域未映射**  
   Bun 的 Web 调试器存在 [“No source files”](https://github.com/oven-sh/bun/issues/4716) / [sources 不显示](https://github.com/oven-sh/bun/issues/5372) 的已知问题，某些文件或作用域可能只显示为“已编译代码”或无法监控变量。  
   **变通**：在**调用该逻辑的上一层**（例如调用函数的那一行）下断点，在调用栈里点进对应 frame，再看变量；或在该逻辑里临时加 `console.log(变量)` 观察。

3. **依赖/ node_modules 里的代码**  
   第三方代码通常没有你的 TypeScript 源码映射，调试器里看到的是编译后的代码，变量名可能被压缩。  
   **变通**：只在自己的 `src/` 下断点；需要看依赖时在调用栈里看入参/返回值。

4. **Source map**  
   本项目已在 `packages/opencode-router/tsconfig.json` 中开启 `sourceMap: true`，便于 Bun 在直接跑 `.ts` 时尽量把断点映射回源码。若你改为先 `pnpm build` 再跑 `dist/*.js`，需确保构建产物带 source map，调试器才能正确对应到 `.ts`。
