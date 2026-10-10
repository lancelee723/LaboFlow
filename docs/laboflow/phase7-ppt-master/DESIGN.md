# PPT-Master 独立插件化与工作台中心化交互 — 设计文档

- 日期：2026-10-11
- 状态：已批准（对话内逐节确认）
- 上游决策：ADR 0040（单引擎）；本设计衍生 ADR 0041（抽仓与分发）
- 取证来源：会话 `380f7277`（"PPT Test"，2026-10-08，93 事件全量分析）

## 1. 背景与问题

用户设想：`/` 选择 PPT-Master 技能 → 输入 Prompt → AI 自动打开右侧 PPT 工作台
→ 在工作台中按管线逐步对话、确认参数、完成编制。

实测（PPT Test 会话）暴露四个问题：

| # | 现象 | 根因 |
|---|------|------|
| P1 | 工作台不自动打开 | 无任何机制：插件 API 只能开浮动面板，不能开停靠视图 |
| P2 | 确认走"传统弹窗"（asktool 模态） | 技能前言第 4 条只说"chat 分支停下等待"，未强制 `ppt_stage_submit`；Agent 就地用了 asktool，工作台确认区/通知/状态机全程未发生 |
| P3 | 工作台是"诊断仪表"：「运行时」卡片就绪时无事可做、「管线」罗列状态文件 | 设计面向开发者而非用户 |
| P4 | 会话最终死亡 | ① 一轮内累计重 Python 调用耗尽宿主 RPC 预算（270s→330s）；② 上游强制"实时预览服务"前台 daemon 启动挂死 shell |

另有结构性问题：插件捆绑在 LaboFlow 仓库内（宿主侧 `slides-artifacts.ts`
硬编码插件 ID 与工具名、`builtin-experts.ts` 引用技能、测试/打包全在宿主仓库），
无法解耦开发。

## 2. 目标与非目标

**目标**

- G1 技能激活后工作台自动打开（覆盖显式 `/` 选择与自然语言路由两条路径）
- G2 Stage 1/2 确认唯一入口在工作台（A 面：对话只呈现内容 + 指路 + 停住）
- G3 工作台重构为用户工作面（阶段步进、确认英雄区、页面预览）
- G4 插件抽为独立仓库 `laboflow.ppt-master`，独立开发/版本/测试
- G5 LaboFlow 发行版继续开箱即用（构建期 pinned 拉取 + 内置 wheelhouse 预置不变）
- G6 预览 daemon 禁令：实时预览由工作台 SVG 翻页承担（P4-② 一并解决）

**非目标**

- 宿主 RPC 预算策略改造（P4-①，单独立项）
- 插件公开市场发布（未来可，见 §9 兼容）
- 管线语料/上游 PPT-Master 能力变更

## 3. 已锁定决策

| 决策点 | 结论 | 备选与否决理由 |
|--------|------|----------------|
| 确认面 | A 面：单一确认面，仅工作台 | B 面（聊天流内嵌按钮）需宿主新交互机制，成本高且状态易分裂 |
| 自动打开触发 | 方案 b：`ppt_master_status` 执行时由插件开视图 | 覆盖自然语言路由路径；宿主只需一个通用 API，无 PPT 语义 |
| 实施顺序 | 路线一：先抽仓后重构 | 文件只动一次；热重载利于 UI 迭代；解耦从第一天成为事实 |
| 插件 ID | `laboflow.ppt-master`（v4.0.0，major 因 ID 变更） | 中立名 `pi.*` 名实不符且有冒充上游之嫌 |
| 分发 | 发行版构建期按 bundle.lock 拉取 pinned 版本 | submodule 痛点、不捆绑则体验倒退 |
| P4 处理 | ② daemon 禁令入本迭代；① RPC 预算另立项 | 见非目标 |

## 4. 架构总览

```
新仓库 laboflow-ppt-master（独立开发、独立版本、独立测试链）
  manifest.json        id=laboflow.ppt-master, version=4.0.0
  main.js / lib/*      运行时、状态机、白名单、作业、预算（自 laboflow.slides 迁移）
  skills/ppt-master.md 薄壳前言（本设计 §5 重写确认与 daemon 规则）
  renderer/workbench.html  重设计（§6）
  vendored/ppt-master/     上游语料（filter-repo 保留全部历史）
  scripts/make-wheelhouse.mjs、test/*.test.mjs（15 套件迁移）
  PROVENANCE.md            溯源：LaboFlow 仓库提交 lineage

LaboFlow 仓库（宿主侧最小改动）
  packages/plugin-sdk      ui.openView 类型（§7）
  electron/main/plugin-runtime.ts  openView 实现（services.openView → PluginViewHost.open）
  resources/plugins/       移除 laboflow.slides 捆绑目录
  scripts/fetch-bundled-plugin.mjs + bundle.lock（§8）
  laboflow/slides-artifacts.ts、builtin-experts.ts  可选集成降级（§8.3）
  docs/adr/0041            抽仓与分发 ADR
```

## 5. 交互契约（A 面 + 方案 b）

### 5.1 标准流程

1. 用户 `/laboflow.ppt-master/ppt-master` + Prompt（或自然语言被路由）
2. Agent 首个动作 `ppt_master_status` → 插件执行体调用
   `pi.ui.openView({ view: "workbench" })`（特性检测：API 缺失记日志继续）
3. 管线推进至 Stage 1/2 阻塞点 → Agent **必须**调 `ppt_stage_submit`
   （状态机、pending 渲染、原生通知、read-once 结果均沿用现实现）
4. Agent 停住轮询 `ppt_stage_status`；用户仅在工作台确认区决策
   （确认 / 按方向选择 / 豁免-需理由）
5. confirmed/waived 后管线继续；导出完成注册会话工件（宿主侧可选集成）

### 5.2 前言（skills/ppt-master.md）规则改造

- 规则 4（确认面替换）重写：两阶段确认**必须**经 `ppt_stage_submit` 提交、
  在工作台完成。**禁止**：asktool / 对话内确认 / 代用户确认 / 静默视为确认。
  对话中呈现方案内容全文 + 指引「请在右侧 PPT 工作台确认」后停住。
- 新增规则（daemon 禁令）：禁止启动上游"实时预览服务"（任何前台/后台
  daemon 形式）；实时预览由宿主工作台 SVG 翻页承担，正文相关步骤以
  「预览：打开工作台翻页区」替代。
- 工具描述同步：`ppt_stage_submit` description 增补"唯一确认通道，
  勿用 asktool"；`ppt_master_status` 增补"首次调用会自动打开工作台"。

### 5.3 退役面

- 浮动确认卡整体移除：manifest `ui.panel`、`renderer/confirm-card.html`、
  `openConfirmCard` 命令、`ui.panel` 权限。
- 工作台成为插件唯一 UI 面（manifest 仅余 views: workbench）。

## 6. 工作台重设计

```
┌──────────────────────────────────────────────┐
│ ① 沟通契约 → ② 设计方案 → ③ 页面绘制 → ④ 质检导出   [● 运行时就绪] │  ← 阶段步进条 + 运行时药丸
├──────────────────────────────────────────────┤
│ ②  HERO：待确认方案卡（pending 时）                        │
│      Stage1: 契约字段表格（修改→引导回对话）                │
│      Stage2: 三方向卡片（点选即确认）+ 底部 豁免/确认        │
│  或  页面预览：SVG 翻页 + ↻ ✕ ✎ 页级操作（保留 pageAction） │
├──────────────────────────────────────────────┤
│ 导出历史（紧凑列表：文件名/时间/页数，打开/访达）             │
└──────────────────────────────────────────────┘
```

- 阶段进度推导：pipeline-state.json 各 stage 状态 + svg_output/svg_final/
  exports 目录存在性，不新增状态源。
- 运行时药丸：就绪=绿点"运行时就绪"；非就绪=琥珀 + doctor 一行摘要 +
  「重装」按钮（复用 ppt.setup 通道）。原「运行时」「管线」两张大卡片删除。
- 确认区从底部提升为 pending 时的英雄区；无 pending 时显示页面预览。
- 轮询与桥通道沿用（ppt.getBootstrap/getState/confirmStage/pageAction 等），
  仅展示层重写；8 语言 i18n 保留并新增步进条/药丸文案。

## 7. 宿主 API：`pi.ui.openView`

```ts
ui: {
  /** Open one of THIS plugin's contributed views (work panel). */
  openView: (input: { view: string }) => Promise<void>;
}
```

- 权限：复用既有 `ui.view`（打开自己 contributes 的视图即在该权限语义内）
- 校验：view id 必须 ∈ 本插件 manifest `contributes.views`，越界/未声明 →
  `INVALID_PARAMS`；插件无该权限 → 拒绝
- 实现：plugin-runtime → services.openView（新增 host service 钩子）→
  既有 `PluginViewHost.open(request)`
- 特性检测约定：插件侧 `pi.ui.openView?.(...)` + catch，失败不影响工具结果
- 上游反哺：API 形状按可合并进 PI-Desktop 上游设计

## 8. 分发与兼容

### 8.1 bundle.lock 与拉取脚本

- `apps/desktop/plugins.bundle.json`（放在 resources/plugins **之外**，
  避免被 extraResources 整目录拷入应用包）：
  `{ "laboflow.ppt-master": { "version": "4.0.0", "source": "<本地路径或release zip URL>", "sha256": "…" } }`
- `scripts/fetch-bundled-plugin.mjs`：读锁 → 解包/复制到
  `resources/plugins/laboflow.ppt-master/` → 校验 manifest id/version 与 sha256
- `pack`/`dist*` 脚本前置依赖该步骤；wheelhouse 由插件仓库的发布产物携带，
  LaboFlow 不再单独构建

### 8.2 升级迁移

- ID 变更 → 插件数据目录换新 → venv 首次启动自动预置（离线 wheelhouse，
  用户无感）；旧 `laboflow.slides` 数据目录成孤儿，不阻塞、后续低优清理
- 技能路径变化：`/laboflow.ppt-master/ppt-master`（用户肌肉记忆一次性迁移，
  「新建 PPT」命令的指引文案同步）
- 历史会话转录不受影响（工具调用记录是文本）

### 8.3 宿主耦合点降级

- `slides-artifacts.ts`：`SLIDES_PLUGIN_ID` 改为 `laboflow.ppt-master`；
  注释明确"可选集成，插件缺席时 no-op"（现逻辑本就 best-effort）
- `builtin-experts.ts`：「PPT制作师」绑定 `skills: [ppt-master]` 不变；
  技能名不变，插件缺席时绑定自然失效（提示语已含"若可用"）
- 捆绑校验测试条件化：无 vendored 副本时 skip 而非 fail（裸仓库测试保持绿）

## 9. 测试与验收

### 9.1 插件仓库

- 迁移 15 套件（路径与 ID 适配）+ PPT_IT 真 Python 端到端 + S10 协议回放
- 新增：
  - openView 特性检测降级（API 缺失工具结果不受影响）
  - 前言契约测试：确认规则含 asktool 禁令、daemon 禁令存在且可检索
  - 工作台结构冒烟：步进条/药丸/英雄区/预览/历史 五区存在，旧「运行时」「管线」卡片不再存在
  - 退役断言：manifest 无 ui.panel、无 confirm-card.html、无 openConfirmCard

### 9.2 LaboFlow 仓库

- openView API 单测：权限门控、越界 view 拒绝、未声明 view 拒绝、成功路径
- artifacts 桥按新 ID 的既有测试更新
- 条件化捆绑校验（见 8.3）

### 9.3 实机验收（茂名脚本场景）

`/` 选技能 → 工作台自动打开 → Stage1 契约在工作台确认 → Stage2 方向卡选择
→ 页面绘制 → 质检 → 导出 PPTX；全程：无 asktool、无浮动卡、无 daemon 启动、
导出文件注册工件。任何一步失败即验收失败。

## 10. 交付阶段

| 阶段 | 内容 | 出口条件 |
|------|------|----------|
| 0 | 新仓库建立：filter-repo 抽取、ID 重命名、测试迁移 | 插件仓库全测试绿；LaboFlow 裸仓库测试绿（插件相关测试已条件化/迁移） |
| 1 | 宿主：openView API、移除捆绑、bundle.lock、耦合降级 | LaboFlow 全套件绿 + openView 单测绿 |
| 2 | 插件 UX：前言 A 面改造、daemon 禁令、工作台重设计、确认卡退役 | 插件仓库全套件绿（含新增四类） |
| 3 | 实机验收 + ADR 0041 + DEV-LOG 登记 | §9.3 场景全过 |

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Agent 仍绕过 ppt_stage_submit（P2 复发） | 前言硬规则 + 工具描述 + 阶段 2 契约测试三重钉；实机验收专门检查 |
| openView 与工作面板布局竞态（视图打开时面板被占用） | 复用 PluginViewHost 既有 open 语义（渲染端已处理切换）；验收覆盖 |
| filter-repo 抽取丢失跨目录历史（测试在宿主仓库） | PROVENANCE.md 记录溯源提交区间；vendored 语料历史完整保留（AGPL 审计链） |
| ID 变更导致用户 venv 重装慢 | 离线 wheelhouse 预置已验证（20.8 MiB / 21 wheels）；后台静默 |
| 发行版拉取源不可达（本地路径搬移） | bundle.lock 支持本地与 URL 双源；sha256 校验防错包 |
