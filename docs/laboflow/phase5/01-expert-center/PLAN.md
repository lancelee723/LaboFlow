# PLAN：专家与专家团（模块 01）

| 文档属性 | 内容 |
|---|---|
| 版本 | v1.1（草案，概念修订版） |
| 日期 | 2026-09-12 |
| 关联 | [PRD](PRD.md)、[SPEC](SPEC.md)、[Phase5 总览](../README.md) |
| 依赖 | M-E1 无外部依赖；**M-E2 的后台会话派发依赖共享地基 T53.1（HeadlessAgentDriver，模块 03）——建议其最先合入主干** |
| 工期估算 | 约 5–6 周（2 名工程师）；里程碑 M-E1 → M-E2 → M-E3 |

> 任务格式：**T51.x 任务名**（工作量：S≤2天 / M≤1周 / L≤2周）— 验收标准。
> v1.1 修订：专家执行改为**独立 Agent 会话**（前台召唤 + 后台 headless 派发），存储改为 `.agents/experts/` 定义文件（PI-Desktop 能力档案惯例），**无 SQLite 新表**。

---

## 批次 A：定义层与专家会话（M-E1）

- **T51.1 专家能力类别（capability kind）**（M）：`crates/host-core/src/agent_capabilities.rs` 扩展 kind=`expert`（与 skills/subagents 同机制：全局 `~/.agents/experts/<name>.md` + 项目 `<root>/.agents/experts/` 双作用域、启用态落 `<data>/agent-capabilities/experts.json`）；frontmatter 解析扩展（packages/plugin-sdk 既有 frontmatter 解析器加字段：industry/tags/examples/skills/mcpServers/budgetTokens，蓝本=subagent 定义解析）；RPC：`capabilities.*` 泛型覆盖 expert kind（list/save/delete/toggle，无新方法族）；`builtin-experts.ts` 预设播种（先例=`BUILTIN_SUBAGENT_DOCUMENTS` 与 `builtin-skills.ts`，幂等）。— 验收：定义文件 CRUD/作用域/启用态单测；播种幂等；**无 schema 迁移**；`cargo test` 全绿。
- **T51.2 专家会话启动装配（召唤路径）**（M）：主进程 `ExpertLaunchAdapter`：召唤=创建普通会话 + 启动装配注入专家（`opts.systemPrompt` 既有覆盖点 + 技能目录裁剪为专家 `skills` ∪ 会话既有 + MCP 目录裁剪为 `mcpServers` ∪ 用户显式开启 + 专家 `model` 作为会话默认模型）；`packages/shared/protocol.ts` 新增 `pi-desktop/expert/*`（list/get/save/delete/togglePin/invoke）；会话列表专家标识。— 验收：召唤战略规划分析师 → 人设行为契约单测（mock provider）；会话持久、重启可回访；切换专家开新会话确认。
- **T51.3 专家中心与我的专家页面**（M）：新 page `"experts"`（页面联合类型 + `App.tsx` 懒加载路由 + `Sidebar.tsx` 快速操作「专家」，蓝本=PluginsPage/ScheduledPage 页面接入模式）；专家中心网格（行业 tab + 搜索）/ 我的专家列表（编辑 sheet：分步向导 + 高级模式原文编辑 + `.md` 导入）；卡片组件。— 验收：FR-E-01/02/04/05/06/07；空态/加载态/键盘可操作；8 语言键齐。
- **T51.4 预设内容包**（S）：6 预设专家 + 2 预设专家团定义文件（按 PRD §3.3 表格撰写：frontmatter + 系统提示词正文），经 T51.1 播种分发。— 验收：内容评审通过（lance 签字）；播种后卡片信息完整。

**Gate M-E1**：FR-E-01~07 验收；召唤→专家会话→产出→回到会话继续追问全链路 E2E；v1 双文档导入可用；子代理既有 E2E 不回归。

## 批次 B：后台派发与专家团（M-E2，依赖 T53.1）

- **T51.5 @专家指派（独立会话派发）**（M）：composer `@` 触发弹窗扩展专家源（搜索/置顶/最近/分组）；派发经 **HeadlessAgentDriver** 启动该专家的后台独立会话（persona 装配同 T51.2 + 无人值守策略默认 degrade，联动 R5-6）；当前会话流渲染专家执行卡（进度/消耗/完成/失败 + **点开跳转专家独立会话**）；多专家串行指派的依赖识别（FR-E-17）。— 验收：FR-E-16/17；执行卡与独立会话双向跳转；全局后台并发闸门（默认 3）有效。
- **T51.6 TeamRunner 编排引擎**（L，本模块核心）：`electron/main/team-runner.ts`：① 团长规划（one-shot LLM 调用产出拆解计划 JSON：子任务/成员/依赖，复用 `one-shot-complete.ts`）；② 并行派发——每成员经 HeadlessAgentDriver 启动**独立专家会话**（依赖 DAG + 并发上限 4）；③ 整合（主持人/摘要/拼接三策略的整合 prompt，显式 LLM 调用——修正 v1 蓝本「整合只是提示词约定」的缺口）；④ 预算 enforcement（挂 `tool_budget.rs` 既有机制：80% 预警 / 100% 停止并产出部分综合）；⑤ `team_run` 会话条目事件流（started/plan/dispatched/member-finished/integrated）。— 验收：单测（DAG 调度/预算停止/成员失败不阻断/单成员重跑）；集成（mock provider 3 成员团端到端，事件序列断言）。
- **T51.7 专家团 UI**（M）：召唤专家团流程（任务输入 → 拆解计划确认/直接执行）；状态板（成员卡：待命/执行中/完成/失败 + 实时消耗 + 预算进度条 + 成员会话跳转）；整合成果卡（最终成果 + 贡献摘要）；自定义专家团编辑器（成员/团长风格/整合策略，定义文件同 T51.1 机制 kind=`team`）。— 验收：FR-E-04（独占）/12/13/14/15；预算预警/停止 UI 状态正确。

**Gate M-E2**：FR-E-12~17 验收；「咨询交付团」标准任务（行业研究+数据测算+slide 大纲）端到端 ≤10min、事件流完整；并发压测（2 团 × 4 成员 + 2 个 @指派）无死锁；既有 E2E 不回归。

## 批次 C：组织专家库与打磨（M-E3）

- **T51.8 服务端组织专家库**（M）：`apps/server` 新增 org assets 扩展（表 + 发布/版本/下发清单 API，蓝本=既有 org_skills 实现）；`/org/bootstrap` 载荷增加 `expertPacks[]`；管理台资产页新增专家/专家团发布区。— 验收：发布幂等；成员登录后只读副本落注册表（source=org）且更新有版本提示；RBAC（sys_admin/team_admin）集成测试。
- **T51.9 客户端组织专家接入与分享**（S）：bootstrap 处理 expertPacks（写定义文件 source=org 只读、登出保留但标灰）；组织/个人同名优先级（FR-E-19）；专家包导出/导入（`.md` 定义 + 绑定声明 + 缺失依赖降级提示）。— 验收：下发→可见→版本更新 E2E；跨机器导入可用。
- **T51.10 打磨与收尾**（S）：用量记账联动（FR-E-20）、空态与错误态巡检、用户手册「专家中心」章、i18n 复查。— 验收：Gate E 清单全过。

**Gate E（模块出口）**：见 PRD §5 Gate E（含子代理零变更回归项）。

## 里程碑总览

```
M-E1（约 2.5 周）→ 定义层 + 专家中心 UI + 召唤会话 + 预设包     [无外部依赖]
M-E2（约 2 周）  → @指派（headless 独立会话）+ TeamRunner + 团队 UI [依赖 T53.1]
M-E3（约 1.5 周）→ 组织专家库 + 分享 + 打磨                     → Gate E
```

## 风险与对策

| 风险 | 对策 |
|---|---|
| HeadlessAgentDriver 延期阻塞 M-E2 | T53.1 升格为 Phase 5 共享地基、最先合入（README §3）；极端情况下 M-E2 可临时降级为「派发=自动切到专家前台会话」的过渡形态（不改契约） |
| 专家团整合质量不稳定（LLM 汇总走样） | 整合 prompt 模板化 + 三策略可选；M-E2 试点收集 badcase 迭代预设文案 |
| 后台独立会话并发争抢（专家团 + @指派 + 定时任务共享池） | 全局后台并发闸门统一（与模块 03 共用一个闸门实现）；压测纳入 Gate M-E2 |
| frontmatter 扩展字段与上游子代理解析器冲突 | 解析器扩展按「未知字段容忍」原则实现（只加不改）；契约测试覆盖上游既有字段 |
| 预设内容质量（6 专家人设空洞） | 内容评审独立于代码 Gate；预留 M-E3 迭代窗口 |
