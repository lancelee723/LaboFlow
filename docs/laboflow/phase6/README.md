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

### T6.1 合入 main（T6.0 后，0.5 天）

- `sync/upstream-v0.15.10` → main 快进合并；打 tag `v0.15.10-laboflow.1`。
- main 在此之前保持 v0.14.5 全功能状态（Phase5 收尾基线）。
- 合并后立即跑一次三平台打包冒烟（mac 本地；win/linux 走 CI matrix）。

### T6.2 Phase5 遗留（恢复推进，按 phase5/README 既有裁决）

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
