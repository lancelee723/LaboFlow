# LaboFlow 技术架构 SPEC

| 文档属性 | 内容 |
|---|---|
| 版本 | v1.2（Cortex 对标修订版） |
| 日期 | 2026-09-05 |
| 关联 | 《PRD-LaboFlow-v1.2》（需求来源，本文只讲怎么实现）、《ZCode 功能行为规格基准》（行为验收基准）、《Cortex 逆向调研报告》（架构与 token 对标输入，2026-09-05） |
| 范围 | 客户端（Electron）、服务端（NestJS + Docker）、两者间协议 |

---

## 1. 系统总览

### 1.1 部署拓扑

```
┌──────────────────────────── 客户端（每成员一台） ────────────────────────────┐
│  LaboFlow Desktop (Electron)                                                │
│  ┌ Renderer (React) ──────┐   IPC   ┌ Main Process ──────────────────────┐ │
│  │ UI: 工作台/会话/市场/   │ ◄──────► │ LaboFlow Core                       │ │
│  │ 设置/工作区/用量        │ preload │  ├ AgentService ──► Pi SDK (锁定版本)│ │
│  └────────────────────────┘         │  ├ PermissionEngine (tool_call 钩子) │ │
│                                     │  ├ McpBridge (@modelcontextprotocol)│ │
│                                     │  ├ Orchestrator (子Agent/专家/团队)  │ │
│                                     │  ├ Scheduler (cron)                 │ │
│                                     │  ├ UsageRecorder ─► SQLite          │ │
│                                     │  ├ MarketplaceService              │ │
│                                     │  ├ BrowserService (Chromium/CDP)    │ │
│                                     │  └ SyncClient ─────────────────┐    │ │
│                                     └────────────────────────────────┼────┘ │
└──────────────────────────────────────────────────────────────────────┼──────┘
                                                          HTTPS/REST + WSS
┌──────────────────────────── 服务端（每组织一套，Docker Compose） ────────────┼──────┐
│  ┌ Caddy（反代/TLS/acme.sh 自动证书） ◄───────────────────────────────────┘      │
│  │   ├── /api        → NestJS API（auth/org/teams/workspaces/library/audit）     │
│  │   ├── /gateway    → Model Gateway（双协议中转/计量/配额）                      │
│  │   ├── /ws         → WS 网关（共享会话推流）                                    │
│  │   └── /admin      → Web Console（React 静态站）                               │
│  └── Postgres 16（元数据/配额/共享会话/审计） + 卷：交付物文件/备份               │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │ 上游模型 API（OpenAI 兼容 / Anthropic / Gemini / DeepSeek / GLM / Kimi / Qwen …）
```

### 1.2 关键架构决策（ADR 摘要）

| # | 决策 | 理由 |
|---|---|---|
| ADR-1 | ~~Pi SDK 内嵌于 Electron 主进程（非子进程 RPC）~~ **已被 ADR-13 取代（v1.2）**：改 EngineHost utility process + stdio RPC | 原理由（同进程直连）不敌崩溃隔离与权限边界收益；Cortex 实证 worker 模式可行 |
| ADR-2 | AgentService 防腐层：UI 与 Core 一律不 import Pi 类型 | Pi 周更 breaking changes，升级收口一处 |
| ADR-3 | 客户端本地 SQLite 为单机权威；共享会话服务端权威 | 本地优先 + 离线可用（PRD 1.3/5） |
| ADR-4 | 权限引擎在 Pi extension `tool_call` 钩子内实现 | Pi 官方阻断点 `{block:true}`；覆盖内置/自定义/MCP 全部工具 |
| ADR-5 | 网关双协议（OpenAI Chat Completions + Anthropic Messages），不自研 SDK 协议 | Pi 四种 API 类型中这两种覆盖全部目标上游；客户端零改动切换 |
| ADR-6 | 计量以服务端解析为准 + 响应 usage 透传校准 | 计费口径单一权威（PRD R8） |
| ADR-7 | Monorepo（pnpm workspace）：client / server / shared / docs | 类型契约两端共享（shared 包），一处修改两端编译校验 |
| ADR-8 | 共享会话「条目序号 + 单点回合锁」而非 CRDT | 回合制串行语义（决策 #3）无需冲突合并；实现简单可审计 |
| ADR-9 | ZCode 功能对标走「行为规格复刻」路线：以官方公开文档为基准自行实现，不接触其代码/内部资源 | 合法边界内获得最大还原度；行为规格基准文档为版本化快照（R10） |
| ADR-10 | 扩展格式三兼容：`.claude-plugin` / `.zcode-plugin` / LaboFlow 原生清单，读取优先级 .laboflow > .zcode-plugin > .claude-plugin | 一套解析器吃下 Claude 生态 + ZCode 生态存量插件；写入只落原生格式（与 ZCode「自有格式优先、兼容格式兜底」同策略） |
| ADR-11 | 语义冲突一律取 ZCode 语义（默认权限档、审批五档、定时任务不补跑、提问倒计时等，见基准文档裁决表） | 用户要求对标 ZCode 降低学习成本，交互语义分歧比功能缺失伤害更大 |
| ADR-12 | Memory/Wiki/Hook 子进程等「本地能力」全部以 Pi extension + Core 服务实现，不依赖 ZCode 任何产物 | Pi 扩展面覆盖（events/registerTool/context 钩子）足以实现全部对标语义 |
| ADR-13 | **引擎 worker 进程化（v1.2）：Pi 从主进程内嵌改为 EngineHost 独立进程（Electron utilityProcess），stdio JSON-line RPC 通信**——方法集对齐 Cortex pi-host 实证协议：`ready / prompt / steer / followUp / abort / fork / setModel / setThinkingLevel / compact / getState / getSessionStats / newSession / switchSession / loadSlashCommands / getCommands / getLastAssistantText` | ①引擎崩溃/内存膨胀不拖垮主进程（UI 与审批流保活）；②权限边界清晰（host 进程仅持引擎必需能力，凭据按调用注入）；③ Cortex（Pi 0.84 同内核商用产品）已实证该模式稳定；④ 防腐层不变（ADR-2）：AgentService 接口不动，PiDriver 重构为 EngineHostClient，Pi 升级仍收口于 host 内。**推翻 ADR-1 的「主进程内嵌」，ADR-2/3/4 等其余决策不变** |
| ADR-14 | **Cortex 逆向借鉴边界（v1.2）**：架构模式（worker RPC/产物工作台/skill 双链）、视觉 token 实测值可采信；任何代码与美术资产不拷贝（对方无 LICENSE，保留所有权利） | 合规红线（PRD R11）；开源组件（anydoc/croner/agent-browser/lucide/compound-engineering skills）各有独立宽松许可证，直接采用 |
| ADR-15 | **Browser Use 执行器改用 agent-browser（Apache-2.0）优先、自研 CDP 回退**（v1.2） | 成熟独立二进制（Cortex 同款 0.31.1）、天然进程隔离、跨平台；自研 CDP 保留为无二进制场景回退，授权/权限语义（PRD 4.1.10）不变 |

---

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 客户端框架 | Electron 3x（LTS 最新）+ Vite + TypeScript 5 | electron-builder 出包 |
| UI | React 18 + Tailwind CSS v4 + Radix UI + **lucide-react（经 packages/ui/icons 收敛层，附录 D-D3）** | 决策 #5；图表 Recharts；token 真相源=PRD 附录 D |
| 状态 | Zustand（服务端状态用 TanStack Query） | 轻量、无样板 |
| 渲染 | react-markdown + Shiki + Mermaid + KaTeX；diff 视图自研（unified patch） | 兼容 Skill 内容渲染 |
| i18n | i18next + ICU 日期数字 | zh-CN/en |
| 本地存储 | better-sqlite3（同步 API，主进程） | WAL 模式 |
| 引擎 | @earendil-works/pi-coding-agent（**版本锁定**）运行于 **EngineHost utility process**（ADR-13） | 经 AgentService 收口；RPC 协议见 §4.2 |
| 引擎宿主通信 | stdio JSON-line（newline-delimited JSON，请求-响应 + 事件流） | 对齐 Cortex pi-host 实证形态 |
| MCP | @modelcontextprotocol/sdk | stdio + Streamable HTTP |
| 文档解析 | **@firecrawl/anydoc（v1.2 替换自研抽取）** | 23 种格式；平台二进制经 asarUnpack |
| 调度 | **croner（v1.2 替换 cron-parser+自研解析）** + 自研持久调度器（§4.8 不变） | Cortex 同款；语义仍为「错过=跳过不补跑」 |
| 浏览器执行器 | **agent-browser 二进制（Apache-2.0，ADR-15）优先，自研 CDP 回退** | 授权/权限语义不变（PRD 4.1.10） |
| 产物生成 | **pptxgenjs（PPTX）+ Electron printToPDF（PDF）+ html-to-docx（Word）**（v1.2 Slide 引擎/写作模式） | 均宽松许可 |
| 邮件推送 | **nodemailer（v1.2）** | 消息中心 SMTP 渠道 |
| 语音（P3 可选） | sherpa-onnx-node（本地 ASR/TTS 推理）+ BYOM 语音协议（openai-speech 兼容出网） | 音频零上传（PRD 4.1.27） |
| 服务端 | NestJS 11 + TypeScript + Fastify adapter | 决策 #6 |
| 服务端存储 | PostgreSQL 16 + Prisma（或 Drizzle，实现期定一） | 单库 |
| 实时 | ws（NestJS Gateway） | 共享会话推流 |
| 管理台 | React + Vite + Tailwind（与客户端共享 shared 包与部分组件库） | 独立静态站 |
| 反代/TLS | Caddy 2 + acme.sh（dns/http 模式可配） | 自动续期 |
| CI/CD | GitHub Actions（matrix：win/mac/linux）+ 自托管 runner（出包签名/公证） | |
| 测试 | Vitest（单元）+ Playwright（E2E，三平台矩阵跑关键路径）+ Testcontainers（服务端 PG） | v1.2 增加 EngineHost RPC 契约测试 |

## 3. Monorepo 结构

```
laboflow/
├── apps/
│   ├── desktop/            # Electron 客户端
│   │   ├── src/main/       # 主进程 = LaboFlow Core（见 §4）
│   │   ├── src/renderer/   # React UI
│   │   └── src/shared/     # IPC 类型（三端共享：main/preload/renderer）
│   ├── server/             # NestJS API + Gateway + WS
│   └── admin-console/      # Web 管理台
├── packages/
│   ├── shared/             # 两端共享：DTO、权限/角色枚举、API 客户端类型、常量
│   ├── ui/                 # 共享 React 组件（按钮/表格/主题，desktop 与 admin 复用）
│   │   └── icons/          # v1.2：LaboFlow 图标收敛层（lucide 封装 + 自绘补充，PRD 附录 D-D3）
│   └── consulting-skills/  # 官方咨询 Skill 包（独立发版）
├── deploy/                 # docker-compose.yml、.env.template、Caddyfile、acme 脚本、备份脚本
└── docs/
    ├── PRD/SPEC/PLAN       # 版本化文档（本套）
    └── design/baseline/    # v1.2：双基准截图库（ZCode/Cortex 各 8 屏，附录 D-D5 验收依据）
```

---

## 4. 客户端架构（LaboFlow Core）

### 4.1 进程模型

| 进程 | 职责 | 说明 |
|---|---|---|
| Main | LaboFlow Core 全部服务 + SQLite + 凭据 | 唯一持有完整凭据与文件系统权限的进程 |
| **EngineHost（utility process，v1.2）** | Pi SDK 运行时（多会话复用单 host） | stdio JSON-RPC（§4.2）；崩溃自动重启 + 会话恢复；**凭据不落 host**：模型 API Key 由主进程在每次请求装配（注入 environment 或请求级 header），host 不持久化任何密钥 |
| Renderer ×N | UI 渲染 | contextIsolation 开、nodeIntegration 关 |
| Utility | 网络代理/更新检查 | electron-updater |
| **ResearchWorker（v1.2，P2）** | 深度研究管线（规划/并行检索/综合） | 复用 EngineHost 通信模式；无凭据，检索经主进程代理执行 |
| Browser 执行器 | agent-browser 二进制子进程（ADR-15），回退 BrowserWindow+CDP | 独立 profile；操作经权限引擎 |

### 4.2 AgentService（Pi 防腐层）

对 Core 内其他模块暴露的自有接口（UI 永不 import Pi）：

```ts
interface AgentService {
  createSession(opts: CreateSessionOpts): Promise<SessionHandle>;   // 绑定项目/模型/权限模式/专家
  prompt(id: SessionId, parts: MessagePart[]): Promise<void>;       // 文本/图片/文件引用
  steer(id: SessionId, text: string): Promise<void>;                // 打断注入
  followUp(id: SessionId, text: string): Promise<void>;             // 排队
  abort(id: SessionId): Promise<void>;
  setModel(id: SessionId, channelId: string, model: string): Promise<void>;
  setThinking(id: SessionId, level: 'off'|'low'|'medium'|'high'): Promise<void>;
  compact(id: SessionId): Promise<CompactResult>;
  subscribe(id: SessionId, cb: (ev: CoreEvent) => void): Unsubscribe; // 统一事件模型，见下
  exportSession(id: SessionId, fmt: 'md'|'html'): Promise<Path>;
  forkSession(id: SessionId): Promise<SessionHandle>;
  spawnSubAgent(parent: SessionId, spec: SubAgentSpec): Promise<SessionHandle>; // §4.6
}
```

`CoreEvent`（对 Pi 事件做一次性归一，之后 Pi 升级只改映射层）：`message_delta / message_end / tool_start / tool_update / tool_end(含 diff) / approval_required / plan_proposed / usage(tokens,cost) / agent_settled / error`。

**EngineHost RPC（v1.2，ADR-13）**——AgentService 的实现从「主进程直调 Pi」改为「经 EngineHostClient 走 stdio JSON-line」：

```ts
// 请求-响应（每行一个 JSON 对象；id 关联）
{ id, method: 'prompt' | 'steer' | 'followUp' | 'abort' | 'fork' | 'setModel'
      | 'setThinkingLevel' | 'compact' | 'getState' | 'getSessionStats'
      | 'newSession' | 'switchSession' | 'loadSlashCommands' | 'getCommands'
      | 'getLastAssistantText' | 'ready', params }
{ id, result?, error? }
// 事件流（host → main，转发归一为 CoreEvent）
{ event: 'message_delta' | 'tool_start' | ..., sessionId, payload }
```

- 生命周期：主进程启动后按需拉起 EngineHost（首次 createSession）；空闲 ≥10 分钟自动回收；`ready` 握手校验 Pi 版本与协议版本（不匹配拒绝启动并提示升级客户端）。
- 容错：host 崩溃 → 主进程捕获 exit → 重启 host → 按 SQLite 条目重建会话状态（`switchSession`/`getState`）→ 未完成轮次标记 error 条目并通知 UI；一小时内崩溃 ≥3 次降级为「直连模式」（回退旧 PiDriver 路径，保底可用，UI 横幅提示）。
- 权限引擎仍在主进程（Pi extension 在 host 内只做事件上报与 block 执行，规则决策经 RPC 回主进程——`approval_required` 事件 → 主进程审批卡 → `tool_call` 响应）。**语义与 §4.3 完全一致，仅决策位置移动。**
- 子Agent/专家：同一 host 内多会话（Orchestrator spawn 即 `newSession`，带父会话权限上下文标签）。

Pi 集成要点（host 内）：
- `createAgentSession({ sessionManager: SessionManager.inMemory(), modelRuntime, tools, customTools })`；条目由 LaboFlow 落 SQLite（不用 Pi 本地 JSONL 目录，服务端同步需要结构化存储）。
- AGENTS.md 注入：项目根读取 + 组织下发片段拼接（`agentsFilesOverride`）。
- 渠道 → Pi provider：内置供应商直接映射 Pi 内置 provider；自定义渠道写 `models.json` 等价配置（**每次会话启动时由主进程生成并注入 host 工作目录，用后即焚**）；组织网关注册为 **单一自定义 provider**（`laboflow-gateway`，baseUrl 指向组织服务器，虚拟 Key 作 API key，协议类型按模型标注 anthropic-messages / openai-completions）。
- Pi 版本升级流程：改 pinned 版本 → 跑「升级回归集」（§8）+ EngineHost RPC 契约测试 → 合并。

### 4.3 PermissionEngine

实现为 Pi extension，挂 `tool_call` 钩子：

```
tool_call(input)
  → 规则管线（按序短路）：
     1. 内置兜底黑名单（明确破坏性命令特征，如 rm -rf / 格式化）→ 一律确认
     2. 会话模式规则表（PRD 4.1.3 矩阵：工具类别 × 目标路径∈项目? × 模式）→ auto / confirm / block
     3. 会话内豁免表（"本会话同类自动允许"）→ auto
     4. 组织策略下限（登录组织后；工作区绑定项目映射）→ 提升为 confirm（若更严）
     5. 计划模式状态机：计划未批准 → 一切写/执行/网络 = block(原因:"等待计划批准")
  → confirm 时：经 IPC 发审批卡到 UI，await 用户决策（持久化待审批队列，App 重启可恢复）
  → 返回 {block:false} 或 {block:true, reason}
```

规则表数据驱动（JSON 配置），工具类别映射：`file.read / file.write / cmd.exec / net.request / mcp.<server>.<tool> / browser.action`。子Agent 调用继承父会话模式（Orchestrator 在 spawn 时注入同一引擎实例上下文）。

### 4.4 McpBridge

- 启动已启用 server：stdio（spawn，项目信任目录提示）或 HTTP（Streamable HTTP）。
- 每个 MCP tool 注册为 Pi `customTool`（名称 `mcp__<server>__<tool>`，schema 透传 JSON Schema → TypeBox 转换），输出走 Pi 工具输出规范（截断 50KB/2000 行）。
- 健康状态机：`connecting → ok | failed(retry×3, backoff)`；工具启停映射到 `excludeTools`。
- 市场安装的 MCP 配置落 `mcp_servers` 表并标注来源插件。

### 4.5 数据模型（客户端 SQLite）

```sql
-- 核心：项目/会话
projects(id, name, folder_path, trusted, default_perm_mode, default_channel, workspace_id NULL, created_at, archived_at)
sessions(id, project_id, title, expert_id NULL, shared_workspace_id NULL, remote_seq NULL, perm_mode, status, created_at, updated_at)
session_entries(id, session_id, seq, kind /*message|tool|approval|plan|usage|branch*/, payload JSON, created_at)  -- 会话条目（含工具轨迹）
-- 模型
channels(id, name, kind /*builtin|custom|org*/, protocol /*openai|anthropic|gemini*/, base_url, api_key_enc, models JSON, enabled)
-- 扩展
skills(id, name, source /*builtin|market|local|org*/, version, scope /*global|project*/, project_id NULL, enabled, path)
mcp_servers(id, name, transport, config JSON, status, source_plugin NULL, enabled)
plugins(id, marketplace_id, name, version, manifest JSON, installed_at)
marketplaces(id, kind /*official|git|local*/, url, enabled, last_sync)
-- 专家与团队
experts(id, name, agent_md, soul_md, tools JSON, channel_id, thinking, avatar, source /*personal|org*/, enabled)
team_runs(id, session_id, mode /*commander|roundtable*/, members JSON, budget_tokens, status)
-- 自动化
jobs(id, name, schedule_kind /*cron|interval|once*/, schedule_expr, prompt_template, project_id, channel_id, model, perm_mode, max_runs NULL, enabled, next_run_at, last_run_at)
job_runs(id, job_id, session_id, status /*ok|failed|skipped_degraded|missed_catchup*/, detail, started_at)
-- 用量
usage_events(id, ts, session_id, expert_id NULL, channel_id, model, input_tokens, output_tokens, cost_est, via /*local|gateway*/, cached /*布尔：是否已被服务端校准*/)
-- 权限与杂项
perm_exemptions(id, session_id, tool_class, target, created_at)
kv(key, value)  -- 登录态缓存、策略下限快照、同步游标等
```

迁移：自研版本化迁移器（`migrations/00x_*.sql`，启动时顺序执行，记录 schema_version）。

### 4.6 Orchestrator（子Agent / 专家 / 团队）

- `spawnSubAgent(parent, spec)`：spec = {expertId? | builtin: 'general'|'explore', prompt, maxTokens, toolsOverride}。实现 = 新建 Pi 会话 + 注入专家 system prompt（Agent.md 能力约束 + Soul.md 人格）+ 工具白名单 + 项目上下文摘要（父会话最近 compaction 摘要 + 指定文件）。
- 后台运行：独立事件流汇入父会话 `sub_agent` 条目；完成回填结果消息。并发上限 3（可配）。
- 指挥官模式：主会话 Agent 通过 `dispatch_expert` 自定义工具（或用户 UI 直发）创建团队运行；结果由主 Agent 整合（提示词模板控制）。
- 圆桌轮（P3）：`roundtable` 编排器在专家间传递上一轮发言记录，轮次 ≤N，主持人收束。

### 4.7 BrowserService

**v1.2（ADR-15）**：首选执行器 = agent-browser 二进制（Apache-2.0，随包分发，三平台）；主进程以子进程方式驱动（JSON 指令：navigate/click/type/scroll/screenshot/extract/viewport）。授权与白名单在设置页配置；操作经 PermissionEngine 类别 `browser.action`；标签认领/Chrome 快照导入等语义（PRD 4.1.10）在主进程实现，与执行器解耦。**回退路径**：二进制缺失/不可执行 → BrowserWindow + `--remote-debugging-port` CDP 自研实现（保留现有代码路径）；P3 视觉回退（截图分析）不变。

### 4.8 Scheduler

- 存储：jobs 表即真相源；进程内 `next_run_at` 最小堆 + 定时器；每分钟全表校验（防睡眠漂移）。
- 表达式解析与下次运行计算：**croner（v1.2 替换 cron-parser）**；本地时区；语义为「错过=跳过不补跑、记 skipped」（ZCode 语义，PRD 4.1.8 权威；v1.1 SPEC 中「补跑一次」的旧句作废）。
- 触发 → 按模板渲染提示词（变量 {{date}}/{{project}}）→ `createSession`（复用权限引擎；无人值守下 confirm 动作自动降级为 `skipped_degraded` 并落 job_runs）→ 完成桌面通知 + 消息中心（§4.27）。
- 连续 3 次失败自动 `enabled=false` + 通知。

### 4.9 SyncClient（组织同步）

- 登录：`POST /api/auth/login` → JWT + 用户档案 + 下发包 `{org, role, team, workspaces[], orgChannels[](网关+虚拟Key), orgSkills[], policyFloor{scope,mode}}` → 写 kv/channels/skills。
- 共享会话上行：本地会话「共享」→ `POST /api/workspaces/:id/sessions`（元数据）+ 条目按 seq 增量 `POST .../entries`（幂等：session_id+seq 唯一）。
- 共享会话下行：WS 频道 `workspace:{id}` / `session:{id}` 推 `entry.appended / lock.acquired / lock.released / member.*`；断线重连以 `remote_seq` 增量拉取。
- 回合锁：发言前 `POST .../lock:acquire`（200/409 排队号）；Agent settled 或 90s 心跳超时服务端释放。
- 用量校准：登录后 `GET /api/usage/mine?since=` 拉网关计量，`usage_events.cached=0` 且 via=gateway 的记录以服务端为准合并。
- 离线：队列化上行（本地 outbox 表），在线重放；共享会话离线只读。

### 4.10 IPC 契约（main ↔ renderer）

三份生成物保持同步（shared/ipc）：`main/ipc/handlers.ts`（实现）→ `preload/index.ts`（`window.laboflow.*` 白名单桥）→ `renderer/api/*`（类型化客户端）。通道命名 `<domain>.<action>`：`session.prompt`、`session.subscribe`（事件回推 `session:event`）、`channel.test`、`job.create`、`workspace.lock`…。大负载（工具输出）走结构化克隆，单条上限 8MB（超限截断标记）。

### 4.11 CommandService（v1.1 新增）

- 命令源：内置（/goal /compact /side）+ 用户/工作区 `commands/*.md`（frontmatter 与变量 $ARGUMENTS/$1/$2，格式同基准 §17）+ 插件注册 + 外部导入（扫描 ~/.claude/commands 等目录，复制或软链）。
- `/` 面板聚合：命令 + 技能两分组的统一索引（名称/描述/参数提示），Pi `registerCommand` 注册为 slash 命令；`$技能` 标签语法在输入解析层展开为 Skill 调用。
- 命令中心（⌘K）：本地索引（命令/会话 FTS/文件名）统一搜索 + 动作分发。

### 4.12 GoalService（v1.1 新增，P2）

- 状态机：`idle → active → paused → done|cleared`；持久化于会话条目（goal_set/replace/pause/resume/clear/iteration 事件条目），重启恢复。
- 逐轮校验：`agent_settled` 后若 goal active → 注入 verification prompt（要求给出：达成判定 + 证据条目（文件/命令输出引用）+ 下一步动作）→ 判定达成则收尾，否则以「下一步动作」自动开下一轮；todo 未清空强制判未达成。
- 用量上限：goal 级 token/轮数预算（UsageRecorder 聚合查询），触顶自动 pause 并通知。
- 与计划模式互斥：plan 状态下拒绝 set；会话运行中拒绝 set。
- checklist：goal 专属 todo 条目，iteration 序号归属首次出现轮次（渲染层读取）。

### 4.13 MemoryService（v1.1 新增，P2）

- 存储（对齐 ZCode 布局便于手编）：`~/.laboflow/memories/projects/<projectHash>/memory/MEMORY.md`（索引，一行一条）+ `<id>.md`（每事实一文件，frontmatter: type=user|feedback|project|reference）。
- 提取：每轮 `agent_settled` 后异步跑轻量提取模型请求（可用便宜模型，默认随会话模型可配）；产出经去重（与索引语义比对）后写入。
- 召回：`before_agent_start` 钩子注入 MEMORY.md 索引（截断上限 8KB）；仅主对话注入。
- 自然语言管理：输入解析层识别「记住/忘掉/记住了哪些」意图 → 直写存储（不经过模型轮次）。
- 管理页：SQLite 镜像索引（memories 表）支撑 UI 查看/编辑/删除，写回 Markdown 文件（文件为真相源）。

### 4.14 WikiService（v1.1 新增，P2）

- 生成管线：扫描（隐私过滤：git/依赖/构建产物/.gitignore/敏感词文件名/symlink，逐层按需）→ 目录生成（结构化输出）→ 逐页生成（含源码引用 文件:行号）→ 汇总写 `~/.laboflow/repo-wiki/<projectHash>/wiki.json`（元数据：分支/commit/语言/页数/生成时间）。
- 每页独立模型请求（失败重试可配、单请求 3min 超时、单页失败不中止）；过程事件流供 UI「生成中可读」。
- 自动刷新：会话结束 diff 检测（git status / 文件 mtime 快照），有变更才提示/触发重生成。
- 阅读器：两栏渲染 + 引用跳转（文件树定位 + 行高亮）；Mermaid/KaTeX 复用会话渲染器。

### 4.15 EditHistoryService（v1.1 新增，P1）

- **文件快照**：PermissionEngine 放行 file.write 前保存「改前内容」到 SQLite（turn_snapshots 表：session_id/turn_no/path/content_before/sha256）；终端命令产生的变更不快照（标记 cmd 来源，Undo 忽略）。
- 编辑重发：截断会话条目至目标消息前（复用 Pi 树状会话 navigateTree）+ 重发；「对话+文件重置」= 快照逐文件校验（sha256 与当前不符=用户手改过=不可安全恢复）→ 全部可恢复才执行，否则降级提示。
- Undo/Reapply：按 turn 聚合快照，全有或全无；Reapply 保存的「改后内容」反向恢复。

### 4.16 IdleQueue（v1.1 新增，P3）

- idle_tasks 表（FIFO 位次、状态机 排队中/已暂停/执行中/已完成/失败/已取消）+ 闲时判定器（无前台活跃会话 && 系统空闲 ≥N 分钟，powerMonitor API）。
- 执行复用 AgentService.createSession；插话= followUp 队列；每日创建计数（kv 表，自然日重置）。

### 4.17 HooksService（v1.1 扩充，P3）

- 实现 ZCode 兼容子进程协议（基准 §18 全量）：7 事件 × matcher（精确列表/JS 正则）× process/command 执行器；stdin JSON（camelCase+snake_case 别名）、stdout 决策解析（allow/deny 聚合 deny>ask>allow、updatedInput 重校验、additionalContext 注入、Stop block ≤3 次）、退出码 0/2/其他。
- 事件源映射：Pi events → ZCode 事件名（tool_call→PreToolUse/PermissionRequest、tool_result→PostToolUse/PostToolUseFailure、before_agent_start→SessionStart、context→UserPromptSubmit、message_end→Stop）。
- 配置：用户级 config（hooks.enabled 总开关）+ 插件 hooks/hooks.json；项目级忽略（同 ZCode 当前行为）；会话启动快照；插件环境变量 LABOFLOW_PLUGIN_ROOT/DATA + CLAUDE/ZCODE 兼容别名。
- 与 PermissionEngine 集成：Hook 决策插入规则管线第 2 步之后（组织策略下限与硬限制不可被 Hook allow 绕过）。

### 4.18 RemoteDevService（v1.1 新增，P4）

- RemoteTransport 抽象（ssh2 库 / WSL wsl.exe / docker exec+cp），承接 Pi 内置工具的 operations 注入（read/edit/write/bash 远程化）——Pi 工具层原生支持可插拔 operations。
- 远端组件 `~/.laboflow/server`：Node runtime + Pi 包 + MCP 桥；版本协商；下发通道 SFTP 上传或远端 CDN 直拉（sha256 校验）。
- 凭证：SSH 密码/passphrase 走 safeStorage；连接配置存 remote_hosts 表。
- 配置同步：Skill/MCP/Plugin 用户级单向同步（跳过同名、失败隔离、密钥原样写入警示 UI 强提示）。

### 4.19 RemoteControlRelay + BotBridge（v1.1 新增，P4）

- Remote Control：配对 token（随机 URL path 即授权）、单连接强制（会话注册表）、桌面端 ↔ 手机 Web 页的消息协议复用 §4.10 CoreEvent 子集（只读 + 指令提交）；中继通道=组织服务器 WS 频道 `rc:{desktopId}`（未登录走直连模式）。
- Bot Bridge：服务端接收 IM webhook（验签）→ 路由到绑定桌面端（WS 推送）→ 客户端执行 → 出站回传（飞书卡片流式更新 API）；bot 注册表存服务端（工作区范围、回复粒度、启停）。

### 4.20 客户端 SQLite 增量表（v1.1 + v1.2 合并）

```sql
commands(id, name, scope /*user|workspace|builtin|plugin|imported*/, description, argument_hint, prompt, source_path, enabled)
goals(id, session_id, state, description, iteration, budget_tokens NULL, created_at)  -- 事件详情在 session_entries
memories(id, project_hash, type, content, file_path, created_at, updated_at)          -- 镜像索引，文件为真相源
wiki_meta(project_hash PK, path, branch, commit, lang, pages, updated_at)
turn_snapshots(id, session_id, turn_no, path, content_before, content_after NULL, sha256_before, origin /*tool|cmd*/)
idle_tasks(id, title, prompt, project_id, channel_id, model, perm_mode, state, position, created_at, daily_count_date)
remote_hosts(id, kind /*ssh|wsl|docker*/, config_enc, last_connected_at)
rc_sessions(id, token_hash, created_at, revoked_at)
hooks_config(scope, payload JSON)  -- 用户级钩子配置
keymap(action PK, win_binding, mac_binding)  -- 快捷键（默认对齐 ZCode，预留自定义）
-- v1.2 增量
artifacts(id, session_id, project_id, kind /*file|slides|report|chart|web|doc*/, path, title, version, prev_version_id NULL, meta JSON, created_at)
slide_decks(id, project_id, session_id NULL, title, outline JSON /*逐页：版式/标题/要点/讲稿*/, template_id, status /*draft|rendered|exported*/, updated_at)
slide_templates(id, name, kind /*builtin|org*/, version, package_path, meta JSON, enabled)
research_runs(id, session_id, project_id, question, scope /*project|web|both*/, depth, plan JSON /*子问题树*/, status, report_artifact_id NULL, created_at)
notes(id, project_id, content, kind /*flash|organized*/, source /*hotkey|agent*/, created_at)  -- 闪记
media_assets(id, kind /*image|speech|music|video*/, provider_channel_id, prompt, path, meta JSON, created_at)
notifications(id, category /*task|approval|alert|announce*/, title, body, jump_target JSON, read_at NULL, created_at)  -- 60 天轮换
push_channels(kind PK /*email|im*/, config_enc, enabled)  -- SMTP / IM 桥接配置
loop_defs(id, name, graph JSON /*节点+连线*/, enabled, created_at, updated_at)
loop_runs(id, loop_id, status, started_at, finished_at, trace JSON /*节点状态/耗时/token*/)
```

### 4.21 ArtifactService（v1.2 新增，P1）

- 产物识别：`tool_end(file.write/edit)` 与 Slide/研究/媒体服务的产出统一登记 `artifacts` 表（path + kind + version；同名覆盖 → 新版本记录，prev_version_id 链式）。
- 版本快照：写前内容由 turn_snapshots 复用（§4.15）；产物额外保留产物级当前版指针，回看历史版本 = 读快照链。
- 预览器复用：文本/图片/PDF 内置；Office 走「转 PDF 预览」队列（服务端 P2 / 本地 LibreOffice 检测可用则用）。
- 分屏对比：文本类 diff（复用 §4.15 视图）；图片类左右对照 + 滑动分割线；Office 转文本后 diff。
- 会话导出（md/html）附产物清单（标题/版本/相对路径）。

### 4.22 SlideService（v1.2 新增，P2）

- 管线：输入（主题/大纲/文档产物）→ 大纲方案结构化输出（slide_decks.outline：逐页 {版式, 标题, 要点[], 讲稿}）→ 用户编辑（大纲卡）→ 逐页渲染（HTML 模板 + 内容注入，BEM 类名约束）→ 导出。
- 渲染引擎：每页 = 独立 HTML（模板包 = runtime.html + 样式与版式 CSS + 字体声明）；预览 = Electron WebContentsView 翻页器。
- 导出：**PPTX = pptxgenjs**（大纲映射为文本框/表格/图形，逐页绝对定位对齐渲染稿）；PDF = WebContents printToPDF 逐页合并（pdf-lib）；PNG = WebContents capturePage；网页版 = HTML+资源 zip。
- 模板包格式（builtin/org 两源）：`template.json`（名称/版式清单/占位规则）+ `runtime.html` + assets/；组织模板经组织资产库下发（只读安装）。
- 中文字体：模板声明字体栈；导出 PPTX 不内嵌字体（声明字体名，用户机器缺失回退，UI 提示）。

### 4.23 ResearchService（v1.2 新增，P2）

- ResearchWorker（utility process，无凭据）：编排 = 问题分析（子问题树，plan JSON）→ 并行检索（经主进程 SearchGateway：web=渠道/Tavily-Brave 类 API、project=ripgrep+anydoc）→ 来源筛选与抓取（anydoc 解析网页）→ 综合（分章节草稿 + 引用角标映射表）。
- 主进程职责：检索代理执行（凭据在主进程）、深度/并发预算控制（depth: quick=1 轮×4 并发 / standard=2 轮×6 / deep=3 轮×8）、进度事件转发（子问题卡）、中断（abort 传播，已完成章节保留）。
- 产出：Markdown 报告（含来源清单）→ ArtifactService 登记（kind=report）；引用角标跳转 = 渲染层链接（URL 直开 / 项目路径定位）。
- 用量：每次检索与综合请求记 usage_events（expert_id=NULL，session 维度聚合展示）。

### 4.24 CaptureService（全局捕获三件套，v1.2 新增，P3）

- 双击 ⌘ 检测：主进程全局按键监听（macOS 辅助功能 / Windows 钩子库）+ 前台应用识别；选中文本获取（clipboard 兜底：模拟 ⌘C 读取，须用户授权明示）。
- 闪记：全局热键 → 独立迷你窗口（单行输入）→ notes 表（kind=flash）；「批量整理」动作 = 选中多条 → 主会话指令（Agent 归类入项目笔记）。
- 全局浮框：热键 → 迷你问答窗（绑定默认会话/专家）；Esc 关闭缓存输入；会话权限模式默认 confirm。
- 全部浮窗复用渲染层组件（Tailwind token 一致），进程内为隐藏 BrowserWindow ×3，按需显示。

### 4.25 VoiceService（v1.2 新增，P3）

- 本地 ASR：sherpa-onnx-node + SenseVoice 系模型（首次使用下载至 userData/models，UI 明示体积）；听写 = 流式识别进输入框（可编辑）；转写 = 文件级任务（分段 30s，带时间戳文稿，产物登记）。
- TTS：BYOM 协议（openai-speech 兼容：baseUrl+key+model+voice）；仅朗读最终回复（message_end 触发，流中不读）；edge-tts 类免费源不内置（合规与稳定性）。
- 隔离：模型文件与推理均在主进程侧（不进 EngineHost）；音频数据零上传（ASR 全本地）。

### 4.26 LoopService（v1.2 新增，P3）

- 定义（loop_defs.graph）：节点类型 = trigger（cron/手动/事件）/ session（绑定专家+权限模式+提示词模板）/ condition（表达式：上节点输出字段判断）/ approval（超时策略）/ push（消息中心/邮件/IM）/ end。连线校验（DAG + 防环，最大迭代 10）。
- 运行时：Scheduler 触发或手动 → 拓扑执行器逐节点跑（session 节点 = AgentService.createSession 同构复用；approval 节点 = 消息中心审批卡等待）→ 轨迹写 loop_runs.trace（每节点状态/耗时/token）→ UI 回放（画布点亮 + 节点详情）。
- 与定时任务关系：jobs 表不动；Loop 自有定义表；「升级为 Loop」= 按模板转换生成 loop_defs。
- 并发上限 3（与子Agent 共享配额池）。

### 4.27 NotificationService（消息中心，v1.2 新增，P2）

- 站内：notifications 表 + 侧栏铃铛未读数 + 列表页（60 天轮换，启动时清理）；跳转目标统一为 jump_target JSON（会话/任务/审批/URL）。
- 桌面通知：Electron Notification；**审批类带「批准/拒绝」动作按钮**（supported platforms）。
- 邮件：nodemailer + push_channels(email)（SMTP 凭据 safeStorage）；发送失败降级站内+桌面。
- 分发：各服务（Scheduler/IdleQueue/ResearchService/LoopService/配额告警 SyncClient/服务端公告）→ NotificationService.emit(category, title, body, jump, channels) 统一收口。

### 4.28 WritingService（v1.2 新增，P3）

- 文档模型：md + frontmatter（outline 元数据）；大纲树 = 标题层级解析 + 手动 pin（存 meta）。
- 视图：三栏（大纲/正文/素材）；素材 = artifacts/引用卡片（含来源 URI）；插入引用块带来源标记。
- Agent 协作：选中区间 → 指令浮条 → 后台会话（携带选中文本+上下文窗口）→ 修改以 diff 确认卡呈现 → 应用落稿（turn_snapshots 记录）。
- 导出：md 直出；docx = html-to-docx（模板样式映射：标题/表格/引用样式表，组织模板 P2 资产）→ 交付物库。

### 4.29 MediaService（v1.2 新增，P3）

- 四类生成器（image/speech/music/video）统一接口：generate(kind, prompt, params) → 渠道路由（复用 channels 或独立 media 渠道配置）→ 产物落盘 + artifacts 登记（kind=chart/web 之外的 media 类）。
- 协议适配：openai-images / openai-speech 兼容起步；音乐/视频适配器接口预留（P3 首批裁剪对象）。
- SlideService/WritingService 经接口引用产物（path 注入大纲占位）。

---

## 5. 服务端架构

### 5.1 NestJS 模块

```
apps/server/src/
├── auth/        # 登录/JWT/刷新/强制改密/锁定
├── org/         # 组织信息/策略下限/下发包组装
├── teams/       # 团队 CRUD/成员
├── users/       # 用户 CRUD/重置密码/强制下线
├── gateway/     # 模型中转（双协议路由/上游池/计量）
├── quota/       # 配额策略/计量聚合/余量/告警
├── workspaces/  # 工作区/成员/共享会话/回合锁
├── files/       # 交付物库/版本/预览
├── library/     # 组织 Skill/专家库
├── audit/       # 审计（追加写，异步批量落库）
└── ws/          # WS 网关（频道订阅/推流/在线列表）
```

### 5.2 REST API（摘要，DTO 全量见 packages/shared）

| 域 | 端点（节选） | 说明 |
|---|---|---|
| auth | POST /auth/login、/auth/refresh、/auth/change-password、DELETE /auth/sessions/:id | 首登改密由 login 响应 `mustChangePassword` 驱动 |
| users/teams | CRUD（/users、/teams、/teams/:id/members、POST /users/:id/reset-password） | RBAC 守卫按矩阵（PRD 4.2.2） |
| org | GET /org/bootstrap（登录下发包）、GET/PUT /org/policy-floor | |
| workspaces | CRUD、POST /workspaces/:id/sessions（共享）、POST .../entries、POST .../lock:acquire、GET .../entries?since=、GET/POST /files、GET /files/:id/versions | |
| usage | GET /api/usage/mine、GET /api/usage/team/:id、GET /api/usage/overview（管理台） | |
| quota | CRUD /quota/policies、GET /quota/remaining | |
| gateway | POST /gateway/openai/v1/chat/completions、POST /gateway/anthropic/v1/messages | 对外模型端点（Bearer 虚拟 Key） |
| library | CRUD /library/skills（发布/版本） | |
| remote-control（P4） | POST /rc/pair（生成配对 token）、WS /ws/rc/:desktopId（手机↔桌面中继，单连接强制、token 吊销即断） | 桌面端与服务端保持长连；未登录桌面走直连模式不经服务端 |
| bots（P4） | CRUD /bots（飞书/企业微信/钉钉应用凭证、工作区范围、回复粒度）、POST /bots/webhook/:provider（IM 回调，验签→路由至绑定桌面端） | 出站消息由客户端经 WS 提交、服务端转发 IM API |

WS 事件：`subscribe{workspace|session}` / 推流 `entry.appended{sessionId,seq,entry}`、`lock.{acquired,released,queued}`、`member.{online,offline}`、`quota.warning`。

### 5.3 Model Gateway（网关）

```
请求（虚拟Key鉴权）→ 中间件链：
 1 authn：虚拟Key → 用户/团队
 2 配额预检：quota.check(user, team) 不足 → 429 + Reset-After + 配额体
 3 路由映射：请求模型 → 上游渠道池（健康度优先，同模型多上游容灾）
 4 协议转换（仅跨协议时；同协议直通透传）
 5 流式透传：SSE 分块转发；边转发边累计 usage（stream_options/include_usage 强制注入）
 6 计量落库：usage_logs(user, team, channel, model, in/out tokens, latency, status)
 7 响应头注入 X-Laboflow-Usage（客户端校准）
```

- 计量以**服务端解析为准**（流中累计 + 非流响应 usage 字段），客户端只做校准（ADR-6）。
- 上游探活：每 60s 轻量调用；失败率 >30% 标记 degraded 并告警。
- 超时：上游首字节 30s、总时长 30min；超时安全断流并计量已产生部分。

### 5.4 配额引擎

- 数据：`quota_policies(id, scope /*system|team*/, team_id NULL, subject /*team|user*/, subject_id NULL, kind /*sessions|tokens*/, limit_value, period /*daily|weekly|monthly*/, created_by)`；`quota_counters(subject_type, subject_id, period_kind, period_key /*如 2026-09-W36*/, sessions, tokens_in, tokens_out, updated_at)`。
- 合并算法：生效策略集 = 系统级（全体或本团队）∪ 本团队级（若存在）→ 每维度取 **min(限值)**（从严者生效，PRD 4.2.4）。团队级保存时校验不得宽于系统级（API 拒绝）。
- 计数：网关计量事务内 `UPSERT ... RETURNING` 原子累加；会话数在共享/本地会话创建上报时计数（客户端登录态下新建会话上报，服务端幂等去重 by session uuid）。
- 预检：`SELECT counters FOR UPDATE` → 比较 → 不足拒绝。周期 key 按服务器时区自然日历。

### 5.5 服务端数据模型（Postgres，节选）

```
users(id, username uniq, display_name, password_hash, must_change_password bool, role /*sys_admin|team_admin|member*/, team_id fk, disabled_at, created_at)
teams(id, name, admin_user_id fk uniq /*每团队唯一管理员*/, created_at)
provider_channels(id, name, protocol, base_url, api_key_enc, models jsonb, assign /*all|teams|users*/, jsonb, health, created_by)
virtual_keys(id, user_id fk, token_hash, issued_at, revoked_at)
quota_policies / quota_counters（见 §5.4）
usage_logs(id, ts, user_id, team_id, channel_id, model, tokens_in, tokens_out, latency_ms, status)
workspaces(id, team_id, name, description, created_by)
workspace_members(workspace_id, user_id, perm /*viewer|contributor|manager*/)
shared_sessions(id, workspace_id, owner_id, title, meta jsonb, lock_user_id NULL, lock_heartbeat_at NULL, created_at)
shared_session_entries(session_id, seq bigint, entry jsonb, created_at, UNIQUE(session_id, seq))
deliverables(id, workspace_id, path, current_version_id, source /*upload|session*/, session_id NULL, uploader_id)
deliverable_versions(id, deliverable_id, version_no, size, sha256, storage_key, uploaded_by, created_at)
org_skills(id, name, version, manifest jsonb, storage_key, published_by, published_at)
audit_logs(id, ts, actor_id, action, target, detail jsonb)  -- 追加写，无 UPDATE/DELETE 权限
```

### 5.6 部署（deploy/）

- `docker compose up -d` 起：caddy、api、postgres（数据卷：pgdata、files、backups）。.env：域名、ACME 邮箱与模式（tls/acme 或自带证书）、PG 凭据、管理员初始账号（首启 seed）。
- acme.sh 集成：Caddy 原生 ACME 为主（自动续期），acme.sh 作为 DNS 模式备选脚本（泛域名场景）；证书双写 caddy 挂载卷。
- 升级：`docker compose pull && up -d`，api 启动时跑 Prisma migrate；迁移前自动 pg_dump 快照。
- 备份：每日 cron（宿主）pg_dump + files 卷 tar，保留 N 天（默认 14），`deploy/backup.sh`。

---

## 6. 安全设计

| 面 | 措施 |
|---|---|
| 凭据存储（客户端） | Electron safeStorage（Keychain/DPAPI/libsecret）加密 API Key；DB 不落明文；界面仅尾 4 位 |
| 凭据隔离（组织） | 真实上游 Key 仅服务端；客户端只持虚拟 Key；吊销即时生效 |
| 传输 | 全链路 TLS（Caddy 策略：TLS1.2+、HSTS）；WS 走 WSS |
| 认证 | argon2id；失败锁定；JWT 短效 + refresh 轮换；强制改密流程 |
| 供应链 | 插件安装清单预览；第三方源默认警告；组织策略可禁用第三方源；Pi 依赖精确 pin（沿用其供应链实践）；**v1.2：随包分发的第三方二进制（agent-browser、anydoc 平台包、语音模型）入 sha256 清单并在启动时校验，校验失败拒载并提示重装** |
| 权限 | 最小默认（高危能力全关）；权限引擎兜底黑名单不可关闭；组织策略下限不可被用户降低 |
| 审计 | 服务端追加写审计；网关计量不含请求/响应内容 |
| 沙箱 | Renderer 无 Node；MCP stdio 子进程仅信任目录提示；Browser Use 独立 profile |
| 数据删除 | 删除用户 → 级联删除其共享内容与虚拟 Key；客户端共享缓存 TTL 清理 |

## 7. 可观测性与错误处理

- 客户端：结构化日志（rolling，脱敏选项）一键导出诊断包；崩溃自动捕获（minidump）本地留存，用户主动上传可选。
- 服务端：pino 结构化日志 + /healthz（pg/磁盘/上游探活聚合）；配额告警 Webhook（80%/95%）。
- 错误分类与用户文案：`network / authn / quota / upstream / permission / engine(Pi) / unknown`，每类有客户端标准提示与建议动作（如 quota → 显示重置时间与切换个人渠道入口）。

## 8. 测试策略

| 层 | 内容 |
|---|---|
| 单元 | 权限规则管线（模式×工具×路径 矩阵全组合）、配额合并算法、cron 补跑边界、协议转换 |
| 集成 | 网关双协议透传（Mock 上游 SSE）、回合锁并发（多客户端模拟）、条目幂等同步 |
| E2E（Playwright 三平台） | 冒烟集：建项目→会话→审批→diff→导出；登录→共享会话→排队发言；定时任务触发（fake timer） |
| Pi 升级回归集 | 固定脚本：最小会话/工具调用/审批钩子/子Agent/usage 事件，Pi 版本变更必跑 |
| 安全 | 凭据加密落盘检查、虚拟 Key 越权、审计不可篡改、依赖漏洞扫描（CI） |
| 行为基准回归（v1.1） | 以《ZCode 功能行为规格基准》为验收源自动化的关键用例集：权限四档×工具类别全矩阵（含五档决策与倒计时）、定时任务错过=跳过、编辑重发与快照恢复全有或全无、Goal 逐轮校验与终止三条件、插件双清单解析（.claude-plugin/.zcode-plugin/userConfig）、Hooks 协议契约测试（stdin/stdout 样例对） |
| **EngineHost RPC 契约（v1.2）** | 请求-响应样例对全方法覆盖（含错误码）、事件流序列（message_delta→tool_start→approval_required→tool_end→agent_settled）、host 崩溃重启恢复（kill -9 后会话重建）、ready 版本握手不匹配拒绝 |

## 9. 性能预算与验证

| 指标 | 预算 | 验证方式 |
|---|---|---|
| 冷启动 | ≤3s（M1 机型基线） | E2E 计时 |
| 会话打开 | ≤500ms（1000 条目） | 基准测试入库 |
| 流式渲染 | 60fps 增量追加 | 渲染性能 trace |
| 网关 P95 附加延迟 | ≤80ms | 网关压测（vegeta/k6，200 并发流） |
| SQLite 写入 | 条目写入 ≤5ms | 基准（WAL） |
| 客户端内存 | 空闲 ≤400MB，单会话 ≤800MB | 三平台抽样 |

## 10. 技术风险登记（工程视角）

| 风险 | 概率/影响 | 应对 |
|---|---|---|
| Pi SDK 内嵌的 Node 兼容（Electron ABI / 原生依赖） | 中/高 | ~~P0 spike~~ 已验证可行（P0 完成）；**v1.2 新增风险见下**：utility process 内 Pi 的原生依赖（better-sqlite3 禁入 host、node-pty 禁入 host）——host 仅跑纯 JS 的 Pi SDK，原生模块全部留主进程 |
| **EngineHost RPC 的稳定性与性能（v1.2）** | 中/高 | 流式事件高频（message_delta 每帧）：批量合并（16ms 窗口）+ 背压丢弃旧 delta；契约测试（§8）；降级直连模式保底（§4.2） |
| **agent-browser 二进制供应链与平台覆盖（v1.2）** | 中/中 | Apache-2.0 随包分发 + sha256 清单校验；缺失/失败自动回退自研 CDP（§4.7）；升级走依赖更新通道 |
| better-sqlite3 三平台重编译 | 高/中 | electron-rebuild + prebuild binaries；CI matrix 首日打通 |
| SSE 透传的内存/backpressure | 中/中 | 流式管道逐块转发不缓存全文；压测门槛 |
| 会话条目 schema 演进 | 中/中 | payload JSONB + kind 版本字段；读取端容忍未知 kind |
| Office 预览转换资源占用 | 中/低 | 转换队列限并发；超时降级为下载 |
| **PPTX 导出还原度（v1.2 Slide 引擎）** | 中/中 | pptxgenjs 绝对定位对齐渲染稿；LibreOffice/PowerPoint 双端抽检（每模板 3 页）；版式复杂页降级为「图片页+可编辑文本框」混合模式 |
| **深度研究的检索源与配额（v1.2）** | 中/低 | 检索走 BYOM 渠道（用户可配）；默认深度 standard；无检索渠道时降级「仅项目资料」 |
| Electron 自动更新自托管源 | 低/中 | electron-updater generic provider（静态 JSON + 包），组织可镜像 |
