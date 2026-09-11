# SPEC：专家与专家团（模块 01）

| 文档属性 | 内容 |
|---|---|
| 版本 | v1.1（草案，概念修订版） |
| 日期 | 2026-09-12 |
| 关联 | [PRD](PRD.md)、[PLAN](PLAN.md) |
| 变更面 | host-core（`agent_capabilities.rs` kind 扩展，**无新表无迁移**）、packages/plugin-sdk（frontmatter 字段扩展）、electron/main（ExpertLaunchAdapter / TeamRunner）、shared（新 IPC 命名空间）、渲染层（新页面 + composer 扩展 + 会话标识）、apps/server + admin-console（组织专家库） |
| v1.1 要点 | 专家执行改为独立 Agent 会话（不再走子代理 spawn/白名单）；定义存储改为 `.agents/experts/` Markdown 文件（PI-Desktop 能力档案惯例） |

---

## 1. 架构总览

```
渲染层
 ├─ ExpertsPage（专家中心/我的专家/专家团编辑，蓝本=PluginsPage 页面接入模式）
 ├─ Composer @专家弹窗（mention 源扩展）
 ├─ 会话流：专家执行卡（可跳转独立会话）/ team_run 状态板 / 专家身份条
 └─ 会话列表：专家会话标识
        │ IPC（pi-desktop/expert/*）
主进程（Electron main）
 ├─ ExpertRegistryClient   定义文件 CRUD/播种/组织副本（经 host RPC capabilities.*）
 ├─ ExpertLaunchAdapter    召唤=交互会话启动装配（systemPrompt 覆盖 + 目录裁剪 + 模型绑定）
 ├─ ExpertDispatch         @指派=经 HeadlessAgentDriver 启动后台独立会话（模块 03 共享地基）
 └─ TeamRunner             星型编排：规划(one-shot)→DAG 派发(独立会话)→整合→预算
        │ JSON-RPC（capabilities.* / session.* / tool_budget）
host-core（Rust）
 ├─ agent_capabilities.rs  kind='expert'|'team' 扩展（作用域/启用态，同 skills/subagents 机制）
 ├─ user_subagents.rs      【不改】子代理机制保持 PI-Desktop 原样
 └─ tool_budget.rs         团队预算 enforcement 挂点
```

**核心架构决策**：

1. **专家是独立 Agent，不是子代理**（ADR-E1，用户概念裁决）：专家以**独立会话**执行——前台召唤=人格化交互会话；@指派/专家团成员=后台独立 agent 会话（经 HeadlessAgentDriver，与定时任务/远程指令同一执行底座）。专家会话的工具可见性 = 专家声明的工具链 ∩ 会话权限模式（完整工具目录，**不经** `SUBAGENT_ASSIGNABLE_TOOLS` 白名单）；子代理机制（定义/白名单/Task 工具族/面板）**零改动**，继续服务任务内并发场景。
2. **定义即文件（capability kind）**（ADR-E2）：专家与专家团是 `.agents/` 家族的新能力类别——`~/.agents/experts/<name>.md`（全局）与 `<root>/.agents/experts/<name>.md`（项目）、`~/.agents/teams/<name>.md`；复用 `agent_capabilities.rs` 既有注册表机制（双作用域 + 启用态 `agent-capabilities/*.json`）；预设经 `builtin-experts.ts` 内置（先例=`BUILTIN_SUBAGENT_DOCUMENTS`/`builtin-skills.ts`）。**不新建 SQLite 表**——与 PI-Desktop「skills/subagents 皆 Markdown 定义」的惯例一致。
3. **星型编排，不重建 A2A**（ADR-E3，裁决 R5-2）：专家团由主进程 TeamRunner 中枢编排（规划→派发→整合），成员间不直接通信；ADR-0162/0164 文本留作未来参考。
4. **整合是显式 LLM 调用**（ADR-E4，修正 v1 蓝本缺口）：v1 指挥官模式的「整合」只是主会话总结的提示词约定；v2 的整合是 TeamRunner 内的真实调用，产出结构化整合成果。
5. **后台会话统一底座**（ADR-E5）：@指派、专家团成员、定时任务、远程指令全部经 HeadlessAgentDriver 启动后台会话，共用全局后台并发闸门与无人值守权限策略（R5-6）——避免出现第二套后台执行机制。

## 2. 数据模型（定义文件，非 SQLite）

### 2.1 专家定义（`~/.agents/experts/<name>.md`）

```markdown
---
name: 战略规划分析师
description: 行业与市场结构分析，结论先行的战略视角
industry: 战略与组织            # 行业分类枚举
tags: [市场测算, 竞争分析, 行业扫描]
examples:                      # 任务示例（≤3）
  - 测算某细分行业的 TAM/SAM/SOM 并给出测算逻辑
  - 用波特五力分析某行业的竞争结构
model: org-gateway/deepseek-v3  # 可空=随会话默认
thinkingLevel: medium
skills: [company-slide-spec]    # 工具链：绑定 Skill
mcpServers: [weknora]           # 工具链：绑定 MCP 服务器
budgetTokens: 200000            # 单次运行预算
source: preset                  # preset | personal | org（personal 缺省可省略）
---
（正文 = 该专家的系统提示词：人设 + 方法论 + 输出规范。
 向导生成或高级模式直接编辑；v1 冻结仓库的 Agent.md/Soul.md 双文档在导入时合并至此。）
```

frontmatter 扩展字段由 plugin-sdk 既有 frontmatter 解析器按「**只加不改、未知字段容忍**」原则扩展（不触碰上游子代理既有字段语义）。

### 2.2 专家团定义（`~/.agents/teams/<name>.md`）

```markdown
---
name: 咨询交付团
description: 研究+数据+Slide 的完整交付团队
members: [战略规划分析师, 数据分析专家, PPT制作师]   # 专家名（≤6，团长为编排角色非专家）
leaderStyle: fine              # fine（精细拆解）| coarse（粗放）
integration: moderator         # moderator | summary | sections
budgetTokens: 200000
source: preset
---
（正文 = 团长拆解指令模板 + 整合指令模板，TeamRunner 组装时引用。）
```

### 2.3 运行态

- 专家会话：普通 sessions 记录 + 专家标识（经启动装配写入会话元信息；若 sessions 无等价字段，随 host 迁移加 `origin` 标注列——与模块 03 助理会话标注同一列，见模块 03 SPEC §2.2）。
- 专家团运行：`team_run` 会话条目（沿用会话 entries 机制）：`{kind:'team_run', event:'started'|'plan'|'dispatched'|'member_update'|'budget_warning'|'integrated'|'failed', runId, payload}`；成员独立会话 id 记录在 payload（可跳转）。

## 3. 关键设计

### 3.1 专家→运行时的两条路径（均为独立会话）

| 路径 | 机制 | 装配 |
|---|---|---|
| 召唤（前台） | 普通交互会话 + 启动装配 | `ExpertLaunchAdapter`：`opts.systemPrompt = 专家正文`（`runtime.ts` 既有 systemPrompt 覆盖点）；技能目录=专家 `skills` ∪ 会话既有；MCP 目录=专家 `mcpServers` ∪ 用户显式开启项；`model` 为会话默认模型；会话列表带专家标识 |
| 派发（后台） | HeadlessAgentDriver 独立会话 | 同上装配 + `unattended` 策略（默认 `degrade`：ask 类工具挂起推送审批，30min 超时拒绝，R5-6）；驱动事件流回投当前会话渲染执行卡；执行卡可跳转专家独立会话（会话持久） |

工具链语义（安全模型）：未声明 skills/mcpServers 的专家=纯对话+文件工具（会话权限模式内）；声明后才可见对应能力——满足「配备 Skill/MCP 才间接访问」。**白名单在装配层强制**（目录裁剪），不依赖提示词自觉，也不动子代理白名单。

### 3.2 TeamRunner（`electron/main/team-runner.ts`）

```
run(team, task, parentSessionId)
 1. 计划：leaderStyle 决定拆解 prompt → one-shot-complete 产出 JSON：
    { subtasks: [{ expertName, brief, dependsOn: [idx] }], riskNotes }
    （JSON 解析失败重试 1 次，再失败→暴露原始文本让用户手动分派）
 2. 派发：拓扑排序 + 全局后台并发闸门（成员 ≤4）；
    每成员 HeadlessAgentDriver 启动独立专家会话（3.1 后台装配）+ team_run 事件流
 3. 预算：tool_budget.rs 团队预算池；成员消耗聚合；
    ≥80% → budget_warning；≥100% → 取消未开始、中断执行中（abort）、标记 partial
 4. 整合：integration 策略选择整合 prompt → one-shot LLM，
    输入=任务 + 各成员成果（含 failed 标记），输出=整合成果 + 贡献摘要
 5. 落盘：integrated 事件 + 成果写入发起会话；成员产物登记 artifacts
```

单成员重跑：`retryMember(runId, idx)`——以原 brief 重新派发，完成后重走整合。

### 3.3 IPC 契约（`packages/shared/protocol.ts` 新增）

```
pi-desktop/expert/list|get|save|delete|toggle|togglePin|import|exportPackage
pi-desktop/expert/invoke           {@指派：派发后台独立会话}
pi-desktop/expertTeam/invoke       {召唤确认拆解计划后执行}
pi-desktop/expertTeam/confirmPlan  {runId, editedPlan}
pi-desktop/expertTeam/retryMember  {runId, memberIdx}
事件：pi-desktop/event/expertTeamRun（增量事件，渲染状态板）
```

host-core RPC：经 `capabilities.*` 泛型方法覆盖 expert/team kind（不新增方法族）。

### 3.4 组织专家库（服务端）

- 表：`org_expert_packs(id, org_id, kind 'expert'|'team', name UNIQUE(org_id,name), payload JSONB, version, published_at, published_by)`——payload 即 §2.1/2.2 定义文件的 frontmatter+正文。
- API（sys_admin/team_admin，蓝本=org_skills 发布幂等模式）：`POST/GET/DELETE /org/expert-packs`。
- bootstrap 载荷新增 `expertPacks: [{kind, name, payload, version}]`；客户端 `OrgService` 落为定义文件（upsert by name，source=org，只读；版本变化 UI 提示更新）。

### 3.5 渲染层

- 新 page `"experts"`：`ExpertsPage`（Tab：专家中心 / 我的专家 / 专家团）；路由注册 `App.tsx` + 页面联合类型 + `Sidebar.tsx` 快速操作（蓝本=既有页面接入三件套）。
- Composer：`@` 触发查询函数追加专家源（名称前缀 + pinned/last_used 排序 + 分组头）。
- 会话流：`team_run` 事件渲染状态板；专家执行卡（复用后台任务卡骨架 + 专家身份头 + 跳转按钮）。
- 会话列表：专家会话标识（行业色点 + 名称）。
- i18n：`packages/i18n` 各目录新增 `expert.*` 命名空间键。

### 3.6 预设分发与扩展

- 预设：`builtin-experts.ts`（6 专家）+ `builtin-teams.ts`（2 团）随应用分发，首次启动播种（幂等）。
- 市场（C 级，FR-E-11）：预设专家包以**插件**形态分发（`contributes.skills` 之外增加专家贡献的评估挂 PI-Desktop 插件清单扩展——**不擅自扩展清单 schema**；v1 以「插件内嵌专家定义文件 + 安装时拷入 `~/.agents/experts/`」的零侵入方式实现）。

## 4. 安全设计

- 组织包下发：HTTPS + JWT 既有通道；payload 中 `skills/mcpServers` 仅存**名称引用**，客户端解析时缺失即降级提示，不自动安装外部资源。
- 专家包导入：文件 ≤1MB、frontmatter 白名单字段校验、拒绝可执行内容。
- 工具链裁剪与无人值守策略在装配/驱动层强制；预算在 Rust 层强制。
- 后台专家会话的审批挂起复用模块 03 审批回路（通知 + 批准/拒绝）。

## 5. 测试策略

| 层 | 用例 |
|---|---|
| Rust 单测 | expert/team kind 注册表 CRUD/作用域/启用态/播种幂等；frontmatter 扩展字段解析（含未知字段容忍与上游字段回归） |
| 主进程单测 | 启动装配契约快照（systemPrompt/目录裁剪/模型绑定）；ExpertDispatch（驱动调用参数/并发闸门/事件回投）；TeamRunner：DAG 调度、预算 80%/100%、成员失败不阻断、单成员重跑、JSON 解析失败降级 |
| 集成 | mock provider：召唤会话人设行为；@指派→独立会话→执行卡→跳转；3 成员团端到端（事件序列断言） |
| 回归 | **子代理零变更**：Settings>Agent>Subagents 页、Task 工具族、SubagentPanel 既有 E2E 全绿 |
| E2E | 组织专家发布→bootstrap→只读副本→版本更新 |
