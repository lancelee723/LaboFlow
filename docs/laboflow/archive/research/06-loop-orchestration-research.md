# 调研与方案：Pi 生态的 Loop 模式与专家团编排（模块 01 · 项目 6）

| 文档属性 | 内容 |
|---|---|
| 日期 | 2026-09-12 |
| 任务来源 | lance 指示：专家团的正确形态应是「Pi-Agent 的 Loop 模式」——编排不同专家的工作环节和流程；先研究官方文档与 pi-agent-loop 插件，后规划，再执行 |
| 调研范围 | pi.dev 官方文档、pi-agent-loop 包（pi.dev/packages）、pi-agent-core 0.85.1 源码类型、pi-loom（社区）、本仓库 TeamRunner 现状 |
| 结论 | **官方引擎无「Loop 工作流模式」；pi-agent-loop（官方包生态收录，MIT）定义了一套成熟的 Loop 交互协议，可直接作为我们的规范蓝本**；在 TeamRunner 底座上实现其三模式语义，不引入新依赖 |

---

## 1. 调研发现

### 1.1 pi.dev 官方文档（https://pi.dev/docs/latest）

- **没有任何「Loop 工作流模式」**：全站无 loop 命令/模式/编排文档。
- **没有任何官方多智能体编排文档**：无 subagents/Task/workflow/pipeline 章节。
- 官方给出的编排扩展点是三章：**Extensions**（TypeScript 工具/命令/事件扩展）、**SDK**（Node.js 内嵌）、**RPC mode**（stdin/stdout JSONL 集成）。
- 引擎层确实存在 `agentLoop`（pi-agent-core/dist/agent-loop.d.ts）：`agentLoop(prompts, context, config, signal, streamFn)`——但它是**单会话内层的工具调用循环**（prompt → LLM → 工具 → LLM 直至停止），不是跨阶段的工作流编排。

### 1.2 pi-agent-loop 包（https://pi.dev/packages/pi-agent-loop）

pi.dev Packages 收录的社区扩展（v0.1.1，MIT，16KB，零依赖），为 pi CLI 提供 Loop 能力——**这就是用户所指的「Loop 插件」**。它定义了一套完整、克制、可照搬的交互协议：

| 模式 | 命令 | 语义 |
|---|---|---|
| goal | `/loop goal <描述>` | 重复执行直到 LLM 宣告目标达成（开放轮数） |
| passes | `/loop passes <N> <任务>` | 精确执行 N 轮 |
| pipeline | `/loop pipeline <阶段1\|阶段2\|阶段3> <目标>` | 命名阶段**顺序执行**，走完即停 |

配套机制：

- **`loop_control` 工具**（仅 loop 激活期间可用）：参数 `status: "next" | "done"`（推进/宣告完成）、`summary`（本轮完成内容）、`reason`（done 时的理由）——**由 agent 显式宣告推进与收敛**，而非外层猜测。
- 循环上下文**自动注入 system prompt**（当前模式/目标/轮次），agent 随时知道自己在管线的哪个位置。
- **急停**：`/loop-stop` 与 Ctrl+Shift+X（停止循环并取消当前 turn）。
- TUI 状态条展示模式、目标与迭代计数。
- **架构要点**：它不 spawn 新 agent/会话——是对**当前 agent turn 的重复驱动**（进程内 extension）。

### 1.3 社区参考：pi-loom（MIT）

「确定性多智能体工作流」：代码持有计划（循环/分支/中间结果写成代码），每步一个 LLM agent；原语 `agent()/parallel()/pipeline()/phase()/budget`；中间产物经函数参数传递而非回到主上下文；schema 强约束输出。价值在编排哲学（与我们的星型模型一致），但其形态（独立库 + pi CLI extension）不适用于我们的 sidecar 架构。

### 1.4 本仓库现状

- TeamRunner（T51.6）：团长 one-shot 拆解 → DAG 拓扑 + 并发≤4 派发**独立专家会话**（HeadlessAgentDriver）→ 整合 one-shot；预算 80% 预警/100% 停止；事件流 `team_run`（plan/dispatched/member/integrated）。
- HeadlessAgentDriver：主进程可程序化启动持久 agent 会话——**串联多轮/多阶段的原语已具备**。

## 2. 三方案对比与裁决

| 方案 | 说明 | 裁决 |
|---|---|---|
| A. 直接安装 pi-agent-loop | 它是 pi CLI 的 TUI extension（依赖 pi CLI 的 extension loader 与 TUI widget）；LaboFlow 的 agent 是 sidecar 架构 + 自有插件体系，**不加载 pi CLI extensions** | ❌ 形态不兼容 |
| B. 引入 pi-loom | 编排哲学正确，但独立运行时 + pi-ai 依赖，与既有 tool_budget/事件流/权限体系重复 | ❌ 重复造轮子的反向操作 |
| C. **采纳 pi-agent-loop 的协议语义，在 TeamRunner 底座上实现** | 三模式 + 显式推进（loop_control）+ 状态注入 + 急停，全部映射到既有原语（HeadlessAgentDriver=多轮串联、one-shot=收敛判定、tool_budget=预算、team_run 事件=状态条）；零新依赖、引擎零改动 | ✅ **采纳** |

与「不要自己造轮子」的一致性：Loop 的**协议与语义**以 pi-agent-loop 的公开规范为蓝本（这是官方包生态认可并收录的形态），**执行底座**复用我们既有的 pi-agent-core `agentLoop`（经 sidecar）+ TeamRunner + HeadlessAgentDriver，不发明新的编排 DSL。

## 3. 实施方案（对齐 pi-agent-loop 语义）

### 3.1 三模式映射到专家团

| pi-agent-loop | LaboFlow 落地 |
|---|---|
| `/loop pipeline s1\|s2\|s3 <goal>` | 团队定义 `pipeline` 字段：阶段名序列，**每阶段绑定一名成员专家**（按序执行；阶段产物摘要注入下一阶段 prompt——复用既有 dependsOn 传递机制） |
| `/loop goal <描述>` | 阶段可带 `goal` 收敛语义：每轮完成后由收敛判定（默认 one-shot LLM 判定 pass/fail；可指定评审专家承担）决定 `next`/`done`，`maxRounds` 硬顶（默认 5，防失控） |
| `/loop passes N` | `rounds: N` 固定轮数阶段 |
| `loop_control {status, summary, reason}` | 每轮专家会话的结尾被要求以结构化结尾宣告（提示词契约注入：「若任务未完成，输出 `[LOOP:NEXT] 本轮完成…下一步…`；完成输出 `[LOOP:DONE] 理由`」——与 loop_control 同构，但以文本协议落在我们无工具注入负担的 headless 路径上） |
| 循环上下文注入 system prompt | 每轮 prompt 携带 `[管线阶段 i/n · 第 r 轮 · 目标 … · 上轮摘要 …]` 头 |
| `/loop-stop` / 急停 | `team_run` 事件 `interrupted`：abort 在跑会话、终止后续阶段（既有 abort 路径） |
| TUI 状态条 | 专家团状态板扩展显示 `阶段 i/n · 阶段名 · 第 r 轮` |

### 3.2 数据模型（团队定义扩展，向后兼容）

`~/.agents/teams/<name>.md` frontmatter 新增可选字段：

```
pipeline: 分析|测算|评审        # 阶段名序列（| 分隔；每段须能映射到成员专家名或其别名）
stageExperts: 分析=行业研究员, 测算=数据分析专家, 评审=审稿人
goal: 评审通过全部阻断项为零     # 可选：存在即开启 goal 收敛语义（全局或 per-stage）
rounds: 3                      # 可选：固定轮数（与 goal 互斥；缺省=单轮）
maxRounds: 5                   # goal 模式硬顶（默认 5）
```

- **无 pipeline 字段** → 走现有「团长一键拆解」路径（零破坏）。
- **有 pipeline** → 顺序执行阶段管线；每阶段=该专家的一次独立会话（复用 persona 装配）；阶段间产物传递复用依赖摘要机制。

### 3.3 执行器（TeamRunner 扩展）

```
runPipeline(team, task):
  for i, stage in pipeline:
    prompt = [管线头: 阶段 i/n、目标、上阶段产物摘要、轮次上下文] + stage brief
    result = headlessDriver.start({persona: stageExpert, prompt})
    verdict = result.text 中的 [LOOP:DONE] / [LOOP:NEXT]；无标记视为该阶段单轮完成
    goal 模式: verdict!=DONE 且 round<maxRounds → 以「上轮摘要+继续指令」再起一轮
    产物摘要 = 末轮 finalText 截断（复用 clipResult）
  整合：pipeline 末阶段产物即最终交付（不再做团长综合；若同时定义 integration 则追加）
```

事件流：`team_run {event:'stage', index, name, round, maxRounds}` 新增阶段帧；状态板直接消费。

### 3.4 明确不做（本批）

- 不做可视化画布（v1 状态板展示即可；画布属 LaboFlow v1 PRD 的 Loop 可视化工作流范畴，另立项）。
- 不在单专家会话内注入 `loop_control` 工具（文本协议已覆盖语义，避免引擎侧工具注册改动）。
- 不做跨团队嵌套管线。

## 4. 执行记录

- [x] 调研（pi.dev / pi-agent-loop / pi-agent-core / pi-loom / 现状）——本文档
- [x] 方案评审：随文档提交，lance 过目后实施
- [x] T51.1b host-core 团队定义 pipeline/stageExperts/goal/rounds/maxRounds 字段解析（向后兼容；roundtrip 测试）
- [x] T51.6b TeamRunner runPipeline 执行器 + stage 事件（goal 收敛 [LOOP:DONE] / maxRounds 硬顶未收敛=失败 / 预算闸门 / 急停）
- [x] T51.7b 状态板阶段/轮次显示（stageOf/roundOf i18n ×8）
- [x] 测试：管线顺序/摘要传递/收敛/硬顶/预算/未知专家（6 例，desktop 1369 全绿）
- [ ] 后续（可选）：团队编辑器 UI 的管线阶段编辑（v1 以定义文件手写）；评审专家承担收敛判定（现为本专家自宣告）

## 5. 来源

- pi 官方文档：https://pi.dev/docs/latest（Extensions / SDK / RPC 为编排扩展点；无 Loop 模式）
- pi-agent-loop：https://pi.dev/packages/pi-agent-loop（v0.1.1，MIT，三模式 + loop_control 协议全文）
- pi-agent-core 0.85.1（node_modules 源码类型）：`agentLoop` = 单会话内层工具循环
- pi-loom：https://github.com/betaHi/pi-loom（确定性多智能体编排参考，MIT）
- earendil-works/pi：https://github.com/earendil-works/pi
