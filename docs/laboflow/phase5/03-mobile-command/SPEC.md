# SPEC：手机远程指挥与定时任务（模块 03）

| 文档属性 | 内容 |
|---|---|
| 版本 | v1.0（草案） |
| 日期 | 2026-09-11 |
| 关联 | [PRD](PRD.md)、[PLAN](PLAN.md) |
| 变更面 | host-core（scheduled.rs 扩展 + cron 解析器）、electron/main（HeadlessAgentDriver / im-server / AssistantDispatcher / scheduler-tick）、渲染层（AssistantPage + ScheduledPage 重做）、shared（新 IPC 命名空间） |

---

## 1. 架构总览

```
IM 渠道（模块 04 ChannelAdapter）      本机 HTTP（im-server.ts）        渲染层输入
   │ 渠道消息                              │ POST /im/task                │ 助理页输入框
   └──────────────┬───────────────────────┴──────────────────────────────┘
                  ▼
        AssistantDispatcher（主进程）
          ├─ 指令解析（状态/停止/列表/任务文本）
          ├─ 任务队列（助理会话串行；跨源并发上限）
          ├─ AssistantSessionStore（持久助理会话，落 host-core sessions，kind='assistant'）
          └─ 回推路由（channelMsg.reply / HTTP 响应 / 桌面通知）
                  ▼
        HeadlessAgentDriver（主进程，重构自 agentPrompt 启动路径）
          ├─ resolveAgentRuntimeLaunch 复用（模型/技能/MCP/子代理装配）
          ├─ sidecar "agent.prompt" 直调 + 事件流订阅
          ├─ 无人值守权限策略（严格/降级/宽松）→ 审批挂起钩子
          └─ 完成：finalText + artifacts + 用量记账
                  ▼
        SchedulerTick（主进程 30s + powerMonitor 唤醒事件）
          └─ host-core scheduled.rs（cron 表达式 / 补跑 / 防叠跑 / 运行记录）
```

**核心架构决策**：

1. **HeadlessAgentDriver 是唯一后台执行入口**（ADR-MC1，共享地基）：渲染进程的 `agentPrompt` IPC handler 改为薄壳调用驱动；定时/远程/助理页输入/**模块 01 的专家后台派发**统一走驱动。解决「只有渲染进程能发起回合」的地基缺口，模块 01/04 直接复用而不自建第二套后台机制；驱动接口为专家 persona 装配预留参数（见 §3.1）。
2. **调度评估在主进程、语义在 Rust**（ADR-MC2）：cron 解析与 next-run 计算是 `scheduled.rs` 纯函数（可单测、协议版本 bump）；触发 tick 与补跑决策在主进程（可访问 powerMonitor/启动事件）。数据保证不叠跑：`task_runs` 状态机（running 行存在 → 触发记 skipped）。
3. **助理会话是一种会话标注**（ADR-MC3）：持久助理会话复用 sessions/entries 机制（历史天然落盘重启不丢）；会话标注复用 sessions 既有元信息机制，若无等价字段则随迁移加 `origin` 标注列（同一列同时服务模块 01 的专家会话标识）。不新表（任务登记见 §2.2）。

## 2. 数据模型变更

### 2.1 host-core SQLite（迁移 v14；模块 01 已取消其原 v14 迁移——专家定义走 `.agents/` 文件，不占迁移号）

`scheduled_tasks` 扩展列（同批迁移为 `sessions` 加 `origin` 标注列——助理会话与模块 01 专家会话标识共用；若 sessions 已有等价元信息字段则复用、不加列）：

| 列 | 类型 | 说明 |
|---|---|---|
| cron_expr | TEXT NULL | 5 字段表达式（与 cadence 二选一；保留 cadence 兼容旧行） |
| missed_policy | TEXT | `skip`（默认）/ `catchup` |
| last_missed_at | INTEGER NULL | 补跑判定基准 |
| unattended_policy | TEXT | `strict` / `degrade` / `loose`（无人值守三档） |
| output_target | TEXT(JSON) | `{kind:'session'|'deliverable'|'space', ref}` |
| installed_at | INTEGER | 首启不补跑的判定锚（迁移时=现存最早任务创建时间） |

`task_runs` 扩展列：`trigger`（`manual`/`timer`/`catchup`）、`tokens`、`duration_ms`。保留 90 天滚动清理（boot 时）。

### 2.2 助理任务登记（新表 `assistant_tasks`，随迁移 v14）

```
assistant_tasks(id TEXT PK, source 'webhook'|'channel:<id>'|'local',
                channel_msg_ref JSON NULL, session_id, prompt,
                status 'queued'|'running'|'awaiting_approval'|'succeeded'|'failed'|'interrupted',
                result_text, result_files JSON, error, tokens, created_at, ended_at)
```

## 3. 关键设计

### 3.1 HeadlessAgentDriver

```ts
interface HeadlessRun {
  sessionId?: string;            // 缺省=新建（或助理会话）
  prompt: string;
  projectId?: string;
  persona?: PersonaSpec;         // 模块 01 预留：专家装配（systemPrompt 覆盖 + skills/MCP 目录裁剪 + 模型绑定）
  unattended?: UnattendedPolicy; // 交互路径不传（走会话权限模式）
  budgetTokens?: number;
  onEvent?: (e: DriverEvent) => void;   // status/tool_call/approval_request/artifact/done
}
// 实现：提取 index.ts 中 agentPrompt handler 的装配段（会话解析/launch 组装/sidecar prompt）
// 为 launchAgentRun(run) 服务；IPC handler 与驱动共用；persona 装配逻辑由模块 01 的
// ExpertLaunchAdapter 提供（同一装配也服务前台召唤路径，见 01 SPEC §3.1）。
```

事件流订阅 sidecar NDJSON：进度事件（assistant delta 聚合为步骤摘要）、`asktool.resolve` 请求按策略处置：

- strict → `resolve({behavior:'deny'})` + 记录 `tool_denied` entry；
- degrade → 挂起（不 resolve），登记 assistant_tasks(status=awaiting_approval) + 推送审批卡；30min 定时器超时 → deny；收到批准 → resolve(allow)（仅放行当次）；
- loose → 会话以 auto 模式启动，无 ask。

崩溃恢复：boot 扫描 `assistant_tasks` 与 `task_runs` 中 running/awaiting → 标记 interrupted（可手动重跑）。

### 3.2 cron 解析器（Rust 纯函数，`scheduled.rs`）

- 5 字段（分 时 日 月 周），支持 `*` `,` `-` `*/n` `a-b/n` `a/n`；周 0/7=周日；日&周均具体 → 并集（OR）；月&日均具体 → 交集（标准 cron）。
- `parse(expr) -> Result<CronSpec, CronError>`：越界（分 70/时 25/日 0 或 32/月 13）、区间写反（5-1）、步长 0、空字段 → 结构化错误（字段位+原因），**创建/更新时即拒绝**（RPC 返回 4xx 语义错误）。
- `next_after(spec, from_tz) -> DateTime`：本地时区语义（蓝本=冻结仓库 croner 行为用例移植）。

补跑判定（主进程，启动与每次 tick）：

```
missed = tasks.filter(enabled && missed_policy='catchup' && last_due < now - grace(60s) && 未在跑)
对每个：due_window = [max(last_due, now-24h, installed_at), now]
  存在 due → 取窗口内最近一次 due 触发 trigger='catchup'（一次）；
  due 早于 24h → 过期丢弃（记录 skipped('expired')）
补跑执行延迟 60s（启动稳定后）；首启（now - installed_at < 5min 且无 task_runs）不补。
```

### 3.3 本机 HTTP 服务（im-server.ts）

- 端口：默认 3800，设置可配；占用 → 提示并允许换端口（不自增抢占）。
- 路由：
  - `POST /im/task` `{message, secret?}`：鉴权（body.secret 与配置密钥常量时间比较；或头 `x-laboflow-signature` HMAC-SHA256(body)）→ AssistantDispatcher 入队 → 同步等待（默认 120s 可配）→ `{reply, files}`；超时 → `{taskId, status:'running'}`；
  - `GET /im/task/:id` / `GET /im/task/:id/events`（SSE 状态流）；
  - `POST /api/schedules` / `GET|DELETE /api/schedules[/:id]`（同鉴权域，FR-MC-16）；
  - `GET /im/health`（无鉴权，仅状态）。
- 绑定：默认 `127.0.0.1`；「局域网开放」= 设置开关 + 显式风险确认 + 强制启用密钥；CORS 关闭（快捷指令/脚本不受影响）。
- 稳定性：独立 Server 实例（不挂 renderer 生命周期）；error → 重启 ≤3 次/10min，超限禁用并通知。

### 3.4 AssistantDispatcher

- 队列模型：助理会话内**串行**（前任务完成/失败才执行下一条）；非助理会话的定时任务不受此队列限制（走各自会话）。
- 指令词法：`状态`/`列表`/`停止 <id>` 正则短路（不进模型）。
- 回推：`route(source, payload)`——webhook=HTTP 响应/异步轮询；channel=模块 04 `ChannelAdapter.send()`（文件按通道能力矩阵：飞书 file_key ≤30MB / 企微 ≤20MB 分片 / 公众号仅文本+图文）；本地=助理页 + 桌面通知。
- 状态消息节流：进行中步骤摘要 ≥10s 或步骤变更才推。

### 3.5 IPC 契约（`pi-desktop/assistant/*`、`pi-desktop/automation/*`）

```
assistant/history|send|stop|listRunning|clearHistory
automation/list|upsert|delete|toggle|runNow|runs|templates|saveTemplate|validateCron（预览未来 3 次）
事件：pi-desktop/event/assistantTask（状态变更，助理页与通知消费）
设置：im-server 端口/密钥/局域网开关（pi-desktop/settings 域扩展）
```

### 3.6 渲染层

- 新 page `"assistant"`（页面联合类型 + 路由 + 侧栏「助理」入口）：通道卡区（读模块 04 通道注册表 + 通用 Webhook 状态）、对话历史（assistant 会话渲染复用会话流组件）、输入框。
- `ScheduledPage.tsx` 重做（双模式编辑器/触发预览/运行记录/批量/模板）。

## 4. 安全设计

- 密钥：im-server secret 存 host secrets（AES-256-GCM）；日志中 message/reply 正文脱敏（仅长度与哈希）。
- 鉴权失败限速：10 次/分钟 → 临时封禁来源 5 分钟。
- 局域网模式横幅常驻（设置页与助理页双提示）。
- `/api/schedules` 与 `/im/task` 同鉴权域（不暴露无鉴权写口）。

## 5. 测试策略

| 层 | 用例 |
|---|---|
| Rust 单测 | cron 解析全量（合法枚举/非法枚举/OR 语义/边界月末/DST 用例移植）；next_after 时区用例；补跑窗口判定纯函数 |
| 主进程单测 | HeadlessAgentDriver 契约（事件序列/策略三档的 ask 处置/崩溃恢复标记）；Dispatcher（串行队列/指令词法/回推路由/长文本分片）；im-server（鉴权/超时转异步/SSE/限速/重启） |
| 集成 | mock provider：定时触发→headless 执行→记录→通知；webhook 同步/异步全链路；审批挂起→批准→续跑 |
| 真机 | macOS 合盖过夜补跑；iOS 快捷指令实测；企微/飞书渠道联调（依赖模块 04，联测项挂 Gate MC） |
