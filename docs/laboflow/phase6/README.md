# Phase 6：上游同步收尾与能力重挂载（规划）

| 文档属性 | 内容 |
|---|---|
| 日期 | 2026-09-30 |
| 状态 | 规划，待评审 |
| 前置 | 上游同步分支 `sync/upstream-v0.15.10`（提交 d13284f38，v0.14.5 → v0.15.10，2335 上游提交）已通过全量回归 |
| 裁决来源 | phase5/README.md §4 裁决 R5-1～RP-8 继续有效；本规划新增 T6 系列 |

## 1. 背景与现状

2026-09-30 完成对上游 PI-Desktop v0.15.10 的一次性合并（2335 提交，18 天积压）。
合并策略为「上游结构为准 + fork 语义重投影」，回归基线：

| 套件 | 结果 |
|---|---|
| desktop（node --test） | 3422 pass / 0 fail |
| agent-runtime（vitest） | 1125 / 1125 |
| host-core（cargo test） | 686 / 686 |
| server（vitest，真实 PG） | 204 / 204（Phase5 验收时的 2 个既有失败已消失） |
| shared / plugin-sdk / admin-console | 1124 + 62 + 2 全绿 |
| typecheck / build:js | 0 错误 / exit 0 |

品牌处置：appId/productName/发布产物/权限文案/系统提示词全量重投影为 LaboFlow；
vendored 插件（pi.file-manager / pi.browser）保留上游原始字节与 UPSTREAM.md 校验和
（溯源优先，其中注释品牌随上游）；`changelog-*.ts` 保留上游发布历史语义。

### 挂起的 fork 能力（合并期间主动搁置）

上游对三个 fork 单体文件做了深度模块化重构（`index.ts` 9950→1057 行、
`app-store.ts` 4838→484 行、Composer 迁往 `features/chat/composer/*`），
union 合并不可行。已改用上游版本，fork 的以下能力**暂时不在主干路径上**：

| # | 能力 | 原 mount 点 | 涉及测试（已移 `apps/desktop/test/deferred/`） |
|---|---|---|---|
| 1 | HeadlessAgentDriver 注册 + 定时任务 headless 执行 | index.ts `scheduled.run` 分支 + `consumeTurnSettlement` | —（host 侧服务仍在） |
| 2 | OrgService/OrgWorkspaceHub 会话级接线 | index.ts org 命名空间 + turnSettlement | org-settings（2） |
| 3 | ExpertService/TeamRunner/前台 persona | index.ts `resolveAgentRuntimeLaunch` personaPrompt + `@专家` 拦截 | expert-mention-dispatch（6）、expert-foreground（2） |
| 4 | KbService + KB 引用契约（toolGuidanceClauses） | index.ts 会话启动 + `kb.*` IPC | — |
| 5 | 通道三件套（feishu/wecom/wechat-mp）channelHost.registerIpc | index.ts registerIpc | —（registry 自身测试仍绿） |
| 6 | SpaceIpcHost（团队空间 IPC） | index.ts registerIpc | — |
| 7 | 设置 experts/org/usage 三 tab | settings-search.ts 三目的地 + SettingsPage 挂载 | token-usage-settings（1）、settings-general（2） |
| 8 | Composer plus 菜单（@专家/@团队/$技能/附加会话） | Composer.tsx | expert-mention-dispatch 部分、composer-paste-files（2） |
| 9 | ChatTranscript 专家/团队徽章（FR-E-16）+ KB 引用角标 | ChatTranscript.tsx | — |
| 10 | 侧栏组织按钮 + 消息中心组合 | Sidebar footer | sidebar-footer（1） |
| 11 | Clawhub skillMarketSearch/Install（zip 技能包导入） | index.ts IPC + ClawhubClient | —（client 测试绿） |
| 12 | 队列 sendNow 语义（prioritize→promote 已对齐） | app-store queue-slice | composer-send-state（1） |

## 2. 任务清单

### T6.0 fork 能力重挂载（最高优先，预计 2–3 周）

原则：**不恢复 fork 单体**，全部挂到上游新工厂/模块结构上（R5-10 插件优先继续有效）。
按依赖排序：

1. **T6.0.1 index.ts 服务工厂接线**：OrgService/OrgWorkspaceHub/ExpertService/
   TeamRunner/KbService/channelHost/spaceHost/HeadlessAgentDriver 在上游
   `bootstrap/startup.ts` + `runtime/lifecycle.ts` 编排中注册；
   40 个 fork handler 块的素材从合并提交 d13284f38^（第二父系工作树）不可直接取，
   需从 fork 冻结提交 2cf827396 的 `registerIpc` 中按
   `IPC.invoke/on` 通道名提取（expert*/org*/kb*/channel*/space*/skillMarket*/
   statsGetTokenInsights/composerAttachSession/pullsList 等约 40 通道），
   挂到上游 `ipc/register.ts` 的 RegisterIpcDependencies 依赖注入面之后。
2. **T6.0.2 personaPrompt 链路**：`runtime/session-launch.ts` 已带 personaPrompt
   透传（合并中已移植）；补 `@专家名` 拦截 → HeadlessAgentDriver → 完成卡片回投。
3. **T6.0.3 settings 三 tab**：恢复 settings-search 三目的地 + SettingsPage 挂载
   （ExpertCenter/OrgSettings/UsageStats 页面文件未动，直接接回）。
4. **T6.0.4 Composer plus 菜单**：在上游 `features/chat/composer/` 新增
   `ComposerPlusMenu`（@专家/@团队/$技能/附加会话），不经 fork 旧 Composer。
5. **T6.0.5 ChatTranscript 徽章/角标**：将 `KbCardBadge`/`kbCardKind`/
   `CitationMarkdown` 挂到上游 `features/chat/transcript/ChatTranscript.tsx`。
6. **T6.0.6 Sidebar footer**：SidebarOrgButton + NotificationCenter 接回上游
   footer（TooltipButton 化后重验）。
7. **T6.0.7 deferred 测试回归主套件**：每完成一项移回对应测试；T6.0 全部完成后
   删除 `test/deferred/README.md`。

验收：deferred 清零；desktop 套件 ≥3460 pass / 0 fail；`pnpm dev` 手验
专家召唤→团队执行→组织登录→KB 引用角标全链路。

### T6.1 合入 main（✅ 2026-09-30 完成）

- `sync/upstream-v0.15.10` → main 快进合并（2346 提交）；tag **`laboflow-v0.15.10.1`**。
- 工作区同步迁移：仓库现位于 `/Users/lance/LaboFlow Desktop`（产品标准名），
  旧 `/Users/lance/laboflow-v2` 路径消失；用户可见名（窗口标题/About/页面标题）
  统一为 LaboFlow Desktop（APP_NAME/userData 身份不变，数据零迁移）。
- 实机验收（CDP 实验 E0–E5，见 [E2E-ACCEPTANCE-2026-09-30.md](E2E-ACCEPTANCE-2026-09-30.md)）：
  专家召唤/@指派/组织登录错误链路/plus 菜单通过；随验收修复 3 项
  （fork IPC 注册不可达、Result 包装缺失、召唤状态互斥）与 KB 入口漏项补挂、
  带空格路径的测试解码（4 文件）。main 检出态 desktop 3505 用例 0 fail。

### T6.2 Phase5 遗留（恢复推进，按 phase5/README 既有裁决）

**T6.2-c 模块 06 L3 工作台 ✅（2026-10-01，勘察修正）**：此前记录
「L3 工作台面板后置」有误——工作台视图已在 ppt-l2-rebuild Phase C 实装
（laboflow.slides contributes.views → renderer/workbench.html：运行时
状态卡/管线 stage/翻页预览（左右键）/导出列表）。实机验证：工作面板
launcher 出现「PPT 工作台」入口，视图以独立 WebContentsView 加载，
pluginBridge 就绪，四区域渲染正常（CDP 截图）。仍后置项：模板蒸馏/
组织模板包（T56.10）/产物版本链（FR-PPT-06）——依赖模板实测调优，维持后置。

**T6.2-b 模块 03 cron 调度 ✅（2026-10-01）**：R5-1 落地。
Rust 新增 `scheduled/cron.rs`（5 字段解析器：*/,,-,a/n；周日 0/7 归一；
日+周并集；结构化错误 + `next_after` 逐日扫描 + `last_before` 回溯，
13 单测）；`automation` 接受 `cronExpr`（cadence="cron"，清 schedule，
nextRunAt 由 cron 决定），`recover()` 补跑判定（最近一次错过 + 24h 上限
+ 首启保护 <5min 无运行 + 60s 启动延迟）；renderer `ScheduledEditor`
Cron 模式（`lib/cron-expr.ts` 客户端校验镜像 Rust 规则）+ i18n 九语言。
shared 加 cadence "cron" / ScheduledTask.cronExpr。
实机（CDP）：创建 `*/2 * * * *` 任务 → 30s tick 自动触发 → headless 会话
→ 权限审批（R5-6 严格策略）→ Bash 执行 → 正确回复；运行记录「运行中/
已完成」状态正确。调度管道沿用上游 30s tick，主干零新增触点。
host-core 695/695（+13 cron 单测）· desktop 3506/0。

**T6.2-a 通道凭证持久化 ✅（2026-09-30）**：credential-store 的 setSecretStore
SEAM 正式接通 host-core 密封密钥表（`secrets.set`/`secrets.getForRuntime`/
`secrets.delete`，Rust 零改动——getForRuntime 即主进程 plain read）。
保存写穿、重启恢复，空值保护与显式删除双清有单测锁定
（channels-registry 14/14）。Phase5 验收 §4-7 的重启掉线问题关闭。
实机：新实例启动 0 错误，KB 入口/主链路复验通过。

1. **模块 03 远程指挥与定时任务**（整体暂缓中）：cron+补跑语义（R5-1）、
   助理总控台、通用 Webhook（T53.3）。T53.1 地基已随合并可用，
   上游 v0.15.x 的 scheduled.execute/listRuns IPC 正好是它的上游对位物。
2. **模块 02 尾项**：HTML Yjs CRDT（FR-TC-12/13）、空间上传路由、org_settings 表。
3. **模块 06 L3**：幻灯片工作台面板/翻页器、组织模板包（T56.10）、
   产物版本链（FR-PPT-06）、离线 wheelhouse。
4. **通道凭证持久化**：credential-store 接 host secrets（原计划迁移 v15，
   注意上游 db SCHEMA 已到 20，迁移序号按实际合入顺延）。
5. **上游 UI/UX 规范融入**（本次合并已带入，T6.0 重挂载时沿用）：
   Token 契约 `--ds-*` 全面化（#1166）、思考多级折叠、工作面板标签拖拽（#959）、
   会话右键菜单、provider 卡拖拽排序、托盘会话快捷入口（#402）、
   语音输入设置面、崩溃 dump 上报（#674，按私有化部署隐私要求评估开关）。

### T6.3 外部项（延续 phase5 §4 登记）

5 顾问试点、双引擎盲评、飞书 WSS/企微帧名/公众号真实租户联调、
真实 WeKnora 端到端、30 天 soak、真机合盖补跑。

## 3. 风险与守则

1. **上游漂移**：本次 2335 提交的合并成本（≈1 天）远高于按月小步合并；
   裁决改为**每月评估一次上游同步窗口**（旧 PLAN 横切事项 1 的 4 周节律），
   同步分支模式复用本分支流程（品牌重投影 checklist 见本文档 §4）。
2. **主干触点管控（R5-10）**：T6.0 各项在上游新结构中的挂载点即新触点清单，
   逐项登记进本 README 执行记录。
3. **品牌重投影 checklist**（下次同步复用）：
   - `packages/shared/src/protocol.ts`（APP_* 常量，保留 fork 的 DISPLAY 品牌对）
   - `apps/desktop/package.json`（appId/productName/各平台 artifactName/
     extraDistFiles/NS 权限文案）
   - `packages/agent-runtime/src/mode-prompts.ts`（系统提示词品牌行）
   - `apps/desktop/src/**`、`electron/main/**`、`scripts/**`、`crates/**`、
     `.github/**`、`examples/**` 全量 `PI-Desktop→LaboFlow` 字符串扫替
     （保留 `@pi-desktop` 包名、`pi-desktop/` IPC 前缀、`pi-desktop-host-core`
     二进制名、`resources/plugins/pi.*` 目录名与 vendored 载荷字节）
   - i18n 九语言结构化重建流程（/tmp/loc/merge.mjs 模式，fork 值优先）
   - 测试期望同步重投影（UPSTREAM.md 校验和面**不得**重投影）

## 4. 执行记录

### 实机验收与修复（2026-09-30，T6.0 后）

CDP 实机实验 E0–E5 通过（见 E2E-ACCEPTANCE），随验收修复 4 项：
fork IPC 注册不可达、Result 包装缺失、召唤状态互斥缺失、KB 入口漏项补挂；
另修带空格工作区路径的测试 URL 解码（4 文件）。
main 检出态回归：desktop 3505 用例 0 fail。


### T6.0 fork 能力重挂载完成（2026-09-30，当日）

全部七个子任务完成并过全量回归。`test/deferred/` 目录已删除（八份测试全部
移回主套件转绿）。主干触点清单（R5-10 登记）：

| 触点 | 改动 |
|---|---|
| `laboflow/services.ts`（新） | org/expert/kb/channel/space/headless 八服务工厂 + 40 个 IPC handler（R5-10 主挂载面） |
| `laboflow/settlement.ts`（新） | headless 驱动的回合结算登记/等待/消费 |
| `index.ts` | +3 处：settlement 创建、laboflow 工厂调用（liveCallService 后）、registerIpc 内 fork 通道注册 + persona resolver 注入 |
| `runtime/plans.ts` | `onTurnSettled` 钩子签名追加可选 `info?: { reason; errorCode }`（向后兼容） |
| `ipc/agent-ipc.ts` | deps 可选 `resolveExpertPersona` + agentPrompt launch 时注入 personaPrompt |
| `lib/settings-search.ts` | 恢复 experts/org/usage 三目的地 |
| `features/settings/SettingsPage.tsx` | 三 tab 挂载 + 图标 |
| `components/MessageRow.tsx`（features/chat/transcript） | KbCardBadge + CitationMarkdown（FR-E-16 / FR-KB-04） |
| `hooks/use-composer-autocomplete.ts` + `ComposerAutocomplete.tsx` | @picker 专家/团队/上下文组 + 分组头 |
| `features/chat/composer/ComposerToolbar.tsx` | plus 菜单（attach/@context/$skill/@expert/@team 四子模式） |
| `components/Composer.tsx` | attachSessionContext + insertComposerText + onContextSession 接线 |
| `stores/slices/queue-slice.ts` + `stores/expert-mention.ts`（新） | sendPrompt 的 @专家/@团队拦截（matchExpertMention TTL 缓存） |
| `components/Sidebar.tsx` | SidebarOrgButton 回 footer |
| `lib/queued-prompts.ts` | `clearQueuedPromptSendNow` 更名 `demotePromotedQueuedPrompts`（符合 promote 语义，send-state 测试的 fork 约定） |

回归终态：desktop **3495 pass / 0 fail**（合并基线 3422 → +73，含 8 份 deferred
33 用例回归）；agent-runtime 1125/1125；host-core 686/686；typecheck 0；build 绿。

暂留事项：Composer plus 菜单的上下文模式使用 Toolbar 内简化的 contextSessions
（前 8 条）；fork 原版含搜索框与 contextQuery 过滤（contextQuery 状态已接，搜索框
渲染待 UI 打磨）；专家 foreground 的「会话绑定 persona 在重载后仍生效」依赖
registry 持久化（已有测试覆盖）。

### T6.2-c 补充：PPT 工作台全链路实机验收 + 4 项修复（2026-10-02）

以真实用户路径跑通 PPT 全流程（CDP 驱动 + 确认卡实点）：粘贴上传脚本
`Tester.md`（3 页）→ agent 走 ppt-master L2 管线 → Stage-1 沟通契约确认 →
Stage-2 三方向确认（麦府经典蓝）→ 3 页 SVG 绘制 + 质检（修正 1 处环形图）→
finalize_svg → svg_to_pptx 导出。产物：
`apps/projects/maoming_chantou_20261002/exports/maoming_chantou_20261002_013056.pptx`
（OOXML、3 页、每页原生可编辑 DrawingML 67–77KB、含演讲备注；质检
passed-with-warnings，9 条均为咨询性提示）。工作台实机验证：载入项目、翻页
预览（1–6/6 渲染 SVG）、管线四 gate 全 confirmed、导出列表带打开入口。

过程中修复 4 项缺陷（均有回归测试，见
`test/slides-plugin-regressions.test.mjs`，slides 系 60/60 绿）：

1. **技能整体未加载**：manifest 声明了 `contributes.skills` 但缺少
   `agent.prompt.inject` 权限，`registerSkills` 静默跳过全部技能——PPT 工作流
   指令从未进入 agent 提示词。补齐权限。
2. **空格路径安装失败**：`getPluginDir()` 用 `URL.pathname`（百分号编码），
   仓库路径含空格时 requirements/vendored 脚本全部找不到。改 `fileURLToPath`。
3. **工作台脚本整体死亡**：init 对动态创建的 `#t-noexports` 无空值保护，
   首次打开必抛 TypeError，全部按钮监听未挂载（静态布局照常渲染，故视觉
   检查未能发现）。加保护。
4. **确认卡不随新 Stage 刷新**：`openPanel` 对已开面板仅 focus，卡面停留在
   上一 Stage，需手动关闭重开。卡片现在在 focus/可见时检测 pending Stage
   变化并重载（不覆盖未提交的意见草稿）。

已知约束：glm-5.3-flash(max) 在超长上下文（~725KB）下单轮输出整页 SVG 会
触发 provider 空响应（EMPTY_MODEL_RESPONSE, retriable），采用「单页/轮」
粒度推进可稳定完成。确认卡 Stage-2 提交后 agent 停轮等待设计使确认动作
需要在会话里再推进一次（工具语义如此，非缺陷）。

### 补充：确认卡/工作台暗色模式对比度修复（2026-10-02）

用户报告 Stage-1 确认卡在暗色模式下「半透明、显示不对」。根因：两个面板页
引用 `var(--pi-bg, transparent)` / `var(--pi-fg, #1f2328)`，但宿主从不向
插件页面注入这对 token——暗色窗口底 `#181818` 配恒定近黑文字，深底深字
看起来像半透明。修复：两页面本地定义 token 对并随 `prefers-color-scheme`
切换（暗色 `#181818`/`#e6e8eb`，与 builtinWindowBackground 一致，标题栏
取色样本保持吻合）。实机验证暗/亮两模式渲染均正常。潜在后续：宿主 preload
可考虑向 v2 面板/视图页面统一注入该 token 对（跨插件契约，暂不动）。
