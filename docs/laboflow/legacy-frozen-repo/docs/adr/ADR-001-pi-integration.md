# ADR-001: Pi 引擎内嵌方案（T0.3 Spike 结论）

- 状态：**已接受（已验证）**
- 日期：2026-09-04
- 关联：SPEC ADR-1/ADR-2、PLAN T0.3、PRD R1

## 背景

SPEC 假设：`@earendil-works/pi-coding-agent` 以 SDK 形式内嵌于 Electron 主进程（同进程直连，而非子进程 RPC）。该假设需要在真实环境验证：Node/Electron ABI 兼容性、打包（asar）路径、SDK API 形态、以及无外部 API key 条件下的端到端可运行性。

## Spike 设计

- **驱动**：`PiDriver`（`src/main/services/agent/pi-driver.ts`），结构化重声明 Pi 表面类型（防腐层，ADR-2），仅依赖文档化 SDK 面：`ModelRuntime.create` + `SessionManager.inMemory` + `createAgentSession` + `session.subscribe/prompt/abort`。
- **模型供给**：零依赖本地 mock OpenAI Chat Completions SSE 服务（`src/main/services/mock-provider.ts`），两阶段脚本化：①流式返回 `tool_calls`（`consulting_demo`）→ ②收到 tool 结果后流式返回文本。Pi 通过 `models.json`（`modelsPath` 注入，指向 `agentDir` 隔离目录）注册自定义 provider，全程无外部网络。
- **验证通道**：① headless（plain Node，`pnpm spike`）；② Electron 主进程（`LABOFLOW_E2E=1`）；③ 真实 UI（键盘驱动 composer → IPC → Pi → 流式渲染）。

## 结果

| 项 | 结果 |
|---|---|
| Pi 加载与集成 | ✅ plain Node 与 Electron 主进程均可加载并创建会话 |
| 流式 | ✅ `message_update` 增量 → 渲染层流式气泡（Node 6 deltas / UI 实测流式） |
| 工具调用 | ✅ `tool_execution_start/end`，custom tool（TypeBox schema）真实读文件 |
| 持久化 | ✅ user/tool/assistant 条目写入 SQLite，重启后完整恢复（UI+E2E 双验证） |
| Electron ABI | ✅ Electron 44（arm64）+ better-sqlite3 13（@electron/rebuild 预编译）无冲突 |
| 性能 | headless 全链路 36ms（不含 UI 渲染） |

## Spike 过程中发现的关键事实（对后续工程有约束力）

1. **上游缺陷**：`pi-coding-agent@0.85.0` 缺失依赖声明 `@earendil-works/pi-server`（入口链 `experimental/server.js` 引用）。已用 pnpm `packageExtensions` 修补（根 package.json）。**升级 Pi 版本时必须复查此补丁。**
2. **禁止 bundle Pi**：esbuild 打包 Pi 会破坏其 `import.meta.url`（`config.js` 顶层调用）。Pi 及全部 `@earendil-works/*` 必须保持 external，以 node_modules 原样加载；electron-builder 需 `asarUnpack`（已配置）。
3. **配置完全可注入，无需 HOME hack**：`ModelRuntime.create({ modelsPath, authPath, modelsStorePath })` + `createAgentSession({ agentDir, cwd })` 足以把 Pi 状态全部圈进 `userData/pi` 隔离目录。
4. **自定义 provider**：`models.json` 顶层 `{ providers: { <id>: { baseUrl, apiKey, api: 'openai-completions'|'anthropic-messages'|…, models: [{id, contextWindow, maxTokens, …}] } } }`——组织网关（P2）将复用同一机制注册为单一 provider。
5. **SDK 事件面**：`message_start/update/end`、`tool_execution_start/update/end`、`agent_start/end/settled`、`turn_start/end`；`prompt()` 返回即本轮结束。已映射为 LaboFlow `CoreEvent`（§4.2）。
6. **沙箱 preload 限制**：preload（sandbox）不能 require `node:*` 模块——preload 桥只允许 electron API。
7. **备选路径（未启用）**：子进程 RPC 模式（`rpc-entry` export 存在、`runRpcMode` 可用）保留为性能/稳定性备选，P1 若遇同进程资源冲突可切换。

## 决策

**维持 ADR-1：Pi 以 SDK 形式内嵌 Electron 主进程**，AgentService 防腐层收口全部调用；Pi 版本锁定 `0.85.0`（exact pin），升级走 SPEC §8「Pi 升级回归集」。

## 证据

- `pnpm spike`：`✅ PASS`（deltas=6, toolStart=1, toolEnd=1, 36ms）
- `LABOFLOW_E2E=1`：`{"eventKinds":["message_end","tool_start","tool_end","message_delta","agent_settled"], "persistedKinds":["message","tool","message"], "driver":"pi"} ✅ PASS`（同目录二次启动 `sessions after create: 2` 证明恢复）
- UI 实测截图：用户气泡 → 工具卡（consulting_demo）→ Markdown 回复；⌘K 命令中心；亮/暗主题与中/英切换；重启恢复（见 P0 验收报告）
