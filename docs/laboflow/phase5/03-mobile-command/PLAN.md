# PLAN：手机远程指挥与定时任务（模块 03）

| 文档属性 | 内容 |
|---|---|
| 版本 | v1.0（草案） |
| 日期 | 2026-09-11 |
| 关联 | [PRD](PRD.md)、[SPEC](SPEC.md)、[Phase5 总览](../README.md) |
| 依赖 | T53.1/T53.2/T53.3 **不依赖模块 04**（通用 Webhook 先行可用）；T53.5 起接模块 04 通道（至少飞书可用） |
| 工期估算 | 约 5 周（2 名工程师）；T53.1 建议单独提前合入主干 |

> 任务格式：**T53.x 任务名**（S/M/L/XL）— 验收标准。

---

## 批次 A：headless 地基（可先行独立合入）

- **T53.1 HeadlessAgentDriver**（L，**Phase 5 共享地基**，01 后台专家派发 / 03 定时与远程 / 04 通道任务共用，建议本任务最先独立合入主干）：把 `index.ts` 中 `agentPrompt` IPC handler 的会话启动/装配逻辑（`resolveAgentRuntimeLaunch` 一带）重构为主进程可复用的 `HeadlessAgentDriver`：`run({sessionId?|new, prompt, projectId, permPolicy, budget, persona?}) → {finalText, sessionId, artifacts}`，直接调用 sidecar `agent.prompt`，订阅事件流（进度/审批请求钩子）；渲染进程路径改为调用同一驱动（行为不变）。`persona` 参数为模块 01 的专家装配预留（systemPrompt 覆盖 + 目录裁剪）。— 验收：契约测试（驱动接口/事件序列/persona 装配）；kill 渲染窗口后驱动任务继续跑完；既有交互会话 E2E 不回归（重构安全网）。
- **T53.2 调度器 cron 与补跑**（M）：`crates/host-core/src/scheduled.rs` 扩展：`cron_expr` 字段 + Rust 侧 5 字段解析器（纯函数：next-run 计算/非法即错误，蓝本=冻结仓库 croner 语义）；`missed_policy`（skip|catchup）；主进程 30s tick 评估器 + 睡眠唤醒事件（powerMonitor）触发即时评估；补跑四规则（只补最近一次/24h 窗口/首启标记 installedAt 不补/启动延迟 60s）；同任务 running 状态防叠跑；上限放宽 50。— 验收：解析器全量单测（含 `0 9 1 * 1` 或语义、`5-1` 报错、`70` 报错、`5/10`）；补跑四规则集成测试（模拟 missedRunAt 各场景）；tick 精度 NFR-MC1。
- **T53.3 本机 HTTP 服务（通用 Webhook）**（M）：主进程 `electron/main/im-server.ts`：127.0.0.1 默认 3800（可配/占用自增提示）；`POST /im/task`（同步 ≤ 可配超时 → 异步 `{taskId}` + `GET /im/task/:id` + SSE）；`/api/schedules` CRUD；HMAC/secret 鉴权（常量时间比较）；局域网开放开关（显式确认）；崩溃自动重启。蓝本=冻结仓库 BotBridge 的 generic 信封 + RemoteControlService 本地服务先例。— 验收：鉴权拒绝/通过用例；iOS 快捷指令真实调用一条；超时转异步正确；端口冲突处理。

## 批次 B：自动化页与助理页（M-MC1/M-MC2）

- **T53.4 自动化页升级**（M）：`ScheduledPage.tsx` 重做：双模式编辑器（结构化 + cron 文本，实时校验与未来 3 次触发预览）、补跑开关、无人值守权限策略选择、输出目的地（会话/交付物库/团队空间）、运行记录视图（trigger 标注 catchup）、批量开关/删除、模板库（内置 4 + 存为模板）。— 验收：FR-MC-09~16 UI 全覆盖；非法 cron 即时红字；批量操作 E2E。
- **T53.5 助理模式页**（M）：新 page `"assistant"`：顶部通道卡（状态灯/设置入口/引导；来自模块 04 通道注册表，未装模块 04 时仅显示通用 Webhook 与本机输入）；统一对话历史（助理会话渲染，落盘）；底部输入框（HeadlessAgentDriver 派发）；状态/停止/列表内建指令。— 验收：FR-MC-01/02/05；重启历史不丢；指令排队串行。
- **T53.6 结果回推与状态消息**（M）：AssistantDispatcher：任务状态机（queued/running/succeeded/failed/interrupted）+ 渠道回推接口（`ChannelAdapter.reply(channelMsg, payload)`——模块 04 提供；本任务先实现通用 Webhook 回推即 HTTP 响应 + 本机通知）；长文本分片与文件回传（通道能力矩阵适配层）。— 验收：FR-MC-03/04/19；同步/异步两模式返回正确；退出前托盘气泡。

**Gate M-MC1+M-MC2 合并门**：cron/补跑/防叠跑/自停全绿；通用 Webhook 端到端（快捷指令实测）；助理页历史持久化；既有 E2E 不回归。

## 批次 C：无人值守与审批（M-MC3）

- **T53.7 无人值守权限策略**（M）：HeadlessAgentDriver 接入策略三档：严格=ask 类工具调用自动 deny（记录）；降级=挂起（复用审批请求钩子）+ 30min 超时自动拒绝；宽松=auto（保存时二次确认）。策略随任务配置持久化。— 验收：三档 E2E（mock 工具触发 ask 路径）；挂起任务崩溃重启后仍可恢复审批。
- **T53.8 审批回路**（M）：审批卡推送三出口（本机通知/助理页/来源渠道——渠道出口依赖模块 04 的回复发送能力）；批准/拒绝指令解析（含 IM 文本「批准」「拒绝」）；恢复执行。— 验收：FR-MC-18；通知点击直达挂起任务；30min 超时自动拒绝。

**Gate MC（模块出口）**：见 PRD §5；另加：macOS 真机合盖过夜补跑验证；安全自查（密钥存储/日志脱敏/绑定点）。

## 里程碑总览

```
M-MC1（约 2.5 周）→ headless 驱动 + cron/补跑 + 自动化页      [批次 A + T53.4]
M-MC2（约 1.5 周）→ 通用 Webhook + 助理页 + 回推              [T53.3/53.5/53.6]
M-MC3（约 1 周）  → 无人值守策略 + 审批回路 + 模板            [批次 C] → Gate MC
```

## 风险与对策

| 风险 | 对策 |
|---|---|
| 重构 agentPrompt 启动路径引入回归 | T53.1 先行独立 PR + 既有 E2E 全量回归为合入门；契约测试固化 |
| cron 语义边界（DST/时区/或语义） | 解析器纯函数全量单测覆盖；本地时区语义与 croner 对齐用例移植 |
| 同步 Webhook 长任务占满连接 | 超时转异步强制路径；连接池与并发上限（2） |
| 降级策略的审批挂起泄漏（永不恢复） | 30min 超时硬顶 + 启动清扫 interrupted 任务 |
