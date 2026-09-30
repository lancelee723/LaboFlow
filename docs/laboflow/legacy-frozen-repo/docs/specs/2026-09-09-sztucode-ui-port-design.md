# LaboFlow UI 全面移植设计（SztuCode 基准）— P5-UI

| 文档属性 | 内容 |
|---|---|
| 文档版本 | v1.0（已批准） |
| 撰写日期 | 2026-09-09 |
| 状态 | 已批准（用户确认四项决策 + 八节设计） |
| 基线 commit | `37f5a1c`（移植前现状快照） |
| 参照物 | /Users/lance/SztuCode/desktop（MIT）。本设计所有视觉数值以其为唯一真相源 |

## 0. 背景与决策记录

LaboFlow 底层（主进程/IPC/Pi 引擎）保持不动，**renderer UI 层全面移植 SztuCode 桌面端的布局、菜单、组件形态与视觉语言**（SztuCode 即 Codex Desktop 形态的开源复刻）。用户已确认的四项决策：

1. **视觉皮肤**：完整移植 SztuCode 视觉（含整套设计令牌与暗色主题），仅品牌资产（Logo/名称/hero 文案）用 LaboFlow 自有。PRD 附录 C/D 的 ZCode×Cortex 双基准自本设计起被取代（见 ADR-002）。
2. **信息架构**：严格复刻 SztuCode 五项侧栏导航（新建任务/全部任务/自动化/技能/浏览器连接 + 项目树）；用量与组织账号收进页脚。
3. **能力边界**：内嵌浏览器 webview、终端、git 源代码管理页只做 UI 外壳 + 引导空态，本轮不动主进程（不加 BrowserView/node-pty/git IPC）。
4. **版本管理**：已 git init 并提交基线 `37f5a1c`，`current/` 与 `参考文件/` 不入库（后者系 PRD D4 合规要求）。

## 1. 实施策略

**就地重写 renderer 组件层（方案 A）**：保留 `store.ts` / `lib/bridge.ts` / IPC 契约（packages/shared）/ 主进程完全不动；重写 renderer 全部组件 + styles + packages/ui tokens；保留 data-testid 验收链。改造面 = renderer ~5,400 行 + packages/ui 199 行。

否决方案：renderer-next 平行新建（5.4k 行体量过度工程）；嵌入 Vue 跑 SztuCode 原码（技术栈分裂）。

## 2. 设计系统（packages/ui → tokens v4）

### 2.1 主题变量（来源：SztuCode `desktop/src/appearance.css:1-52`）

亮色 `:root`：

```
--app-bg:#e6eaeb  --surface:#ffffff  --surface-soft:#eff1f1  --surface-raised:#ffffff
--chrome-bg:#f2f4f5  --border:#d5dadc  --border-strong:#c2c8ca
--text:#202426  --text-muted:#636b6f  --text-faint:#8c9498
--accent:#30383b  --accent-soft:#dce1e3  --accent-contrast:#ffffff  --danger:#b64a42
--shadow-modal:0 24px 70px rgb(26 34 38/22%),0 4px 18px rgb(26 34 38/12%)
--chrome-surface-opacity:68%  --composer-surface-opacity:92%  --inspector-surface-opacity:64%
```

暗色 `[data-app-theme="dark"]`：

```
--app-bg:#171717  --surface:#171717  --surface-soft:#1e1e1e  --surface-raised:#242424
--border:#2e2e2e  --border-strong:#3d3d3d
--text:#ffffff  --text-muted:#b3b3b3(可读性修正，源值全 #ffffff 不可用)  --text-faint:#8a8a8a(同前)
--accent:#d7dddf  --accent-soft:#2c2c2c  --accent-contrast:#171717
--danger:#e37a70  --success:#66d496
--shadow-modal:0 26px 80px rgb(0 0 0/48%),0 5px 20px rgb(0 0 0/32%)
```

侧栏/标题栏暗色统一 `#202020`（appearance.css:585-587）。强调色三变体：blue `#2d6fbe`(soft #e0ebf7) / jade `#26745d`(#deeee8) / coral `#aa5146`(#f5e3e0)；暗色 blue `#78aeea` / jade `#72c5a8` / coral `#ee9a90`。

⚠️ 注意：SztuCode 暗色 text-muted/faint 原值与 text 同为 #ffffff（靠透明度实现层级）。移植时改为显式灰阶并目检对齐截图观感，其余值原样照搬。

### 2.2 字体与字阶（`typography.css:9-20`）

- UI 栈：`"Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC","Segoe UI",sans-serif`
- 代码栈：`"Cascadia Mono","SFMono-Regular",Consolas,monospace`
- 品牌/大标题：`"Aptos Display","Segoe UI Variable Display","Microsoft YaHei UI",sans-serif`
- 字阶：display 42 / hero 26 / page-title 22 / brand 17 / section 16 / item 14 / body 14 / control 13 / caption 12 / micro 11 px

### 2.3 动效令牌（`motion.css:5-33`、`typography.css:4-7`）

`--motion-fast:150ms / popover:180ms / dialog:240ms`；`ease-out: cubic-bezier(.2,.8,.2,1)`、`ease-soft: cubic-bezier(.22,.72,.22,1)`；菜单 transform-origin top left 入场；底部弹层（slash 菜单/模型选择）bottom center 上浮；全部动效尊重 `prefers-reduced-motion`。

### 2.4 主题机制与记账清理

- 由 `html.dark` + MutationObserver 重注改为 **`html[data-app-theme / data-accent / data-wallpaper / data-density]` 属性驱动**（appearance.ts 模式）。
- 三重记账（packages/ui canonical + `--lf-*` 别名 + styles.css :root 静态副本）→ 合并为 packages/ui 单源 + Tailwind v4 `@theme` 映射；`--lf-*` 别名保留一个版本周期。
- 壁纸：纯色（默认）/薄雾/网格/纸纹/自定义；晨雾渐变实现见 SztuCode `workbench.css:945-957`。
- 顺手修：font-scale 统一为 `0.95/1.05/1.15`（现 packages/ui 与 SettingsPage 两处定义冲突）。
- 图标：现有 lucide 收敛层续用（SztuCode 同为 lucide 为主）。

## 3. 应用骨架与信息架构

### 3.1 Shell（`App.vue:3221-3731` + `sztu.css:7` + `workbench.css:851`）

- 网格：标题栏 52px + 主区；侧栏列 `var(--sidebar-width, 268px)`，范围 224–360，localStorage 持久化，⌘B/Ctrl+B 折叠；窗口 <952×640 自动折叠。
- 会话布局 `.work-layout`：`minmax(0,1fr) | 1px | var(--inspector-width,390px)`（范围 340–720）；<1000px 自动收起；开合动画 `grid-template-columns 240ms ease-soft`。
- 平台：macOS 侧栏全高 + 系统菜单栏（LaboFlow menu.ts/KEYMAP 不变，仍是快捷键唯一分发路径）；Windows/Linux 窗口内「文件/编辑/视图/帮助」菜单条 + 自绘窗口钮（close hover `#c42b1c`），视图菜单含底部状态栏开关。

### 3.2 侧栏解剖（自上而下）

品牌区「LaboFlow」+ 搜索钮（居中搜索浮层 `.task-search-popover`）→ 黑色主按钮「新建任务」→ 五项导航（全部任务 LayoutDashboard / 自动化 CalendarClock / 技能 Puzzle / 浏览器连接 Globe2，16px 图标 active 填充态）→ 「项目」标签 + FolderOpen 按钮 → 项目树滚动区（置顶区 → 项目组：项目行 + 每项目 ≤6 条会话行 → 临时任务 → 已归档 `<details>`）→ 页脚：服务状态点（7px，绿 `#38a169` 已连接/琥珀重连中/灰未连接，映射 LaboFlow 引擎状态）+ **用量入口** + 设置齿轮（hover 旋转 45°）+ **账号头像**（组织登录态）。

会话行：hover 显示操作钮；运行中状态 = 3×3 点阵 + 脉冲光晕（`workbench.css:1073-1092`）；未读 6px 蓝点。悬停预览卡 254px（计时/分支/项目/总 tokens）。

### 3.3 功能安置映射（LaboFlow 特有功能一项不丢）

| LaboFlow 现有 | 去向 |
|---|---|
| 用量统计页 | 页脚入口 → 全屏页（view=usage 保留），图表套新皮 |
| 组织登录/工作区/交付物（OrgAccount/OrgPanel） | 页脚头像菜单 + Inspector「组织」tab |
| 插件市场（ExtensionsManager 市场部分） | 技能页「插件」tab |
| MCP 管理 | 「浏览器连接」页（SztuCode 该页即 MCP 服务器卡片页） |
| 技能（本地 + Clawhub 在线安装） | 技能页「技能」tab |
| 定时（SchedulerPanel）+ 闲时（IdlePanel） | 自动化页两分区 |
| 产物/Wiki/子Agent/专家（ContentPanel/ContextPanel） | Inspector 扩展 tab（§5） |
| ⌘K 命令中心 + / 命令 | SlashCommandMenu 形态（composer 内）+ ⌘K 保留 |
| 设置 21 分区 | 设置 Dialog（SztuCode 左 nav 右 pane 形态） |
| 会话三视图/搜索/归档 | 全部任务页 + 侧栏项目树 |

### 3.4 页面机制

`store.view` 扩展：`'work' | 'board' | 'skills' | 'automations' | 'webbridge'`（+ 保留 `'settings' | 'usage'` 全屏页）。设置改为 Dialog 形态后 view='settings' 退役。

## 4. 会话工作区（移植核心）

### 4.1 Landing hero 态（无会话）

居中启动器（内容列 `min(940px,100%)` 上移 -3vh）：LaboFlow Logo 52px + 打字机动画标题（提案文案「Think it. Deliver it.」，40px/560 字重，18 步打字 + 光标闪烁）+ 输入卡（白底、1px #e4e6e8、圆角 14、外层灰底 #f5f5f5 同圆角；textarea 112px 高、**字号 24px**、placeholder 提案「所思，皆成交付」）+ 工具行（+ 钮 25×25 / 盾牌权限 pill / 模型选择器 36px 带状态点 / 黑色发送圆钮 32×32 `#25262a`，停止态 `#c0453f`）+ 卡下项目 pill（999 全圆角）与插件 pill 弹层（项目选择器 320px 带搜索、选中态 #eef4ff 蓝勾）。**「全部允许」二次确认橙盾弹窗**（420px，头 34px `#fff0dc`，主钮红 `#b43b3b`）照搬。

### 4.2 Dock 态 composer

QueueDock 卡统一包裹（队列+输入同卡，宽 `min(660px, calc(100% - 64px))`，圆角 14；队列区 max-height `min(168px,25dvh)`；条目 = 20px 序号徽标 + 文本 + 附件数 pill + 退回编辑/删除/转入当前轮三钮）。附件 chips 类型色：pdf `#d64b47` / word `#3379cf` / excel `#279468` / ppt `#d7773d` / image `#9a67c7`。busy 菜单（steer/排队/停止）、划选引用、编辑重发、溢出菜单（fork/导出/侧会话）功能全保留，皮全部换新。

### 4.3 执行时间线（结构升级，最大增值点）

参照 `ExecutionTimeline.vue`(674) + `ActivityPhase.vue`(620) + `ToolCallCard.vue`(476) + `SessionStatsLine.vue`(90) + `timeline.css`/`workbench.css`：

1. **turn 分组**：事件按用户消息分组；每 turn 含 runId/model/runStats/state(running|waiting|failed|interrupted|done)。
2. **任务进度条**：plan 存在时顶部 4px（轨道 #e5e7eb、完成绿 #16a34a、进行中蓝渐变 `#2563eb→#60a5fa` + shimmer），标签「步骤 {current} / {total}」。
3. **ActivityPhase 编号活动块**：触发行 = 20px 状态圆（运行中蓝 `#2563eb` 底白数字 + pulse 蓝光晕 / 完成绿 `#16a34a` / 失败橙 `#fd9851` 圆叉，**失败不用红**）+ 目的一句话（取 plan stepTitle 或思考首句截 40 字）+ 结果统计（「读取3 · 调用2」，按工具名分桶：read=读取/search=搜索/edit=编辑/exec=执行/call=调用）+ chevron。展开体：左缩进 27px + 1px 竖线，内含思考 pre（灰底 #f9fafb、max-height 240px、rAF 12 字/帧追赶回放）与工具明细列表。思考触发行蓝色微扫光。
4. **ToolCallCard**：单行（14px 图标 + 动作词 + "·" + 等宽路径下划线），done 图标绿 / failed 文字橙 `#b45309` / running 蓝 + LoaderCircle + 秒表；展开参数 JSON + 输出（200 字/6 行截断可展开）+ 截图缩略。
5. **内嵌审批条**（PermissionBadge 形态 × LaboFlow 五档语义融合）：灰底 #f9fafb 圆角 6 条，「等待权限审批」+ 参数预览 + [拒绝] [允许一次（黑底 #374151）] [28px "…" 菜单]。**"…" 菜单承载 LaboFlow 五档**：始终允许 / 始终拒绝 / 允许本会话 / 允许本项目；dangerous 徽章与 **diff 展开（unified/split 双模式）** 保留现有 DiffDetail 实现套新皮。计划卡（PlanCard）同形制。
6. **回合收尾**：折叠为「查看过程 · {duration}」单行（+ChevronDown），失败/中断前置橙色 chip（#b45309/#fdf3e7）；hover 回合操作 26px 钮（复制/分叉=GitFork/回退重试=RotateCw 映射现有 fork/编辑重发语义）；中断显示黑底「继续执行」主按钮；turn 尾用量条（等宽 11px）+ 证据 chips（绿/橙/蓝 pill）。
7. **turn 圆点导航**：流区左缘垂直居中 8px 圆点列（可视 11 个、active 放大 1.5 倍深灰 #374151，hover 气泡，IntersectionObserver 驱动）；右下回到底部 32px 圆钮；自动跟随（离底暂停、回底恢复）。
8. **SessionStatsLine**：composer 上方居中灰字 11px：「{turns} 轮 · {steps} 步 | 首 token 平均 x · y tok/s | 缓存命中 z% | 输入 n tok · 输出 n tok | 上下文 p%」+ 56×5px 进度条（80% 琥珀 `#d29225` / 95% 红 `#b3402f`）。缺指标显示「—」不阻塞。
9. **上下文注入行**（ContextInjectionRow 形态）：折叠行 11px 标题 + 字符数，展开文件 chips + 正文 pre。
10. Markdown 本轮补 **highlight.js** 代码高亮（SztuCode 同款），`.lf-md` 排版按新令牌重写。

## 5. Inspector 分屏（右侧 390px）

参照 `ProjectInspector.vue`(1090) + `FileTree.vue`(610) + `file-rail.css`(1171)：

- 容器 `grid-template-rows: 48px minmax(0,1fr)`，左边 1px #e9ebed。tab 条：`+` 功能菜单（首页/任务摘要/文件/浏览器/终端/**LaboFlow 扩展：产物/Wiki/子Agent/专家/组织**）→ 横向 tab 列表（激活白灰底 #f4f4f4 圆角 8 + 阴影、关闭 X）→ 全屏/关闭钮。
- 首页 `.home-launcher`：「从这里开始」+ 四大按钮。
- 任务摘要：四折叠区（项目画像/待办/任务产物/参考信息）；待办用分段进度点（完成实心/进行中脉冲/待办浅灰）+ 编号列表；产物列表行（类型图标/名称/来源/git 状态）——现有 artifacts 面板数据装入此形态。
- 文件 tab：FileTree（行 31px、选中 `#176fd1` 字 + `#eaf3fd` 底 + 2px 左条）+ 文件页签（max-width 180）+ **预览/源码切换**（Markdown/HTML/SVG 渲染预览，复用 react-markdown；其余 CodePreview）。
- **空态策略（已拍板）**：浏览器 tab、终端 tab = 引导空态（图标 + 说明 + 灰置主按钮「能力即将到来」）；源代码管理页自会话头 GitBranch 图标进入，整页空态（分支条 + 「更改|提交图谱」双 tab 骨架 + 空态文案）。三者零主进程改动。

## 6. 功能页形态

- **全部任务（board）**（`App.vue:3655-3663`）：页头（h1 22px + 副标题 + outline 刷新钮）；行式列表（行高 ≥54px、底边线、置顶左 2px 蓝条 `#397fd0`、标题 + 状态行 + 行尾操作菜单）；归档分组降透明；空态 58px 图标居中。现有搜索/三视图语义并。
- **技能页**（`SkillCenter.vue` 948 + `skill-center.css`）：sticky 毛玻璃顶栏 42px（「插件 | 技能」tab、刷新/设置、黑色「+ 添加」下拉：添加市场源/本地安装/添加技能）→ 页体 `min(calc(100% - 48px), 1080px)` 居中：28px 大标题 + 15px 副标题 → 胶囊搜索（40px 高 20px 全圆角）→ 来源筛选 chips（30px 圆角 8）+ 右侧计数 → 双列卡片网格（卡片 ≥72px、圆角 14、hover 上浮 1px + 阴影、SkillIcon 42px）。插件 tab：已装/市场 chips + 胶囊卡（68px，「已安装」绿 pill 或「+ 安装」描边钮）。Clawhub 在线安装并入；插件详情 440px / 技能详情 480px / 插件管理 520px 弹窗照搬。
- **自动化页**（`AutomationPage.vue` 191）：`padding: 42px clamp(24px,5vw,72px)`、内容 max 1120px；kicker「LOCAL SCHEDULES」（10px mono 绿 `#26845e` 字距 .16em）+ 32px h1；表单卡（16px 圆角、双列 `1.35fr/0.8fr`：任务名+内容 6 行 textarea | 每天/每周/每月三段式 + 时间 + 下次运行绿卡 #eef7f2）；卡片网格 `repeat(auto-fill,minmax(310px,1fr))`（状态点 7px 绿 + 光晕、名称 17px、dl 三行、footer 暂停/恢复）。定时与闲时两分区。
- **浏览器连接页（=MCP）**：逐服务器 bridge-card（图标 + h2 + 状态 pill + 启停）+ 底部说明；stdio 编辑表单弹窗保留现有字段。
- **设置**（SettingsDialog 形态，`SettingsDialog.vue` 2036）：全屏遮罩 + 居中大 Dialog，左 nav（外观/通用/模型管理/连接/关于 + 底部品牌）+ 右 pane。现有 21 分区按此重组：外观（主题三选/壁纸/强调色/密度/字号滑杆/玻璃开关）、通用、模型管理（内嵌 ModelManager）、权限、技能/MCP/插件（跳转对应页）、自动化、记忆、关于。占位分区（voice/media/commands）维持占位。
- **模型管理**（`ModelManager.vue` 2012 + `ModelConfigMenu.vue` 184 + `ReasoningEffortSlider.vue` 180）：920×720 弹窗（eyebrow + 21px h1）、工具行（统计 + 当前模型绿条 + 黑色「+ 添加模型」）、4 列模型表 `1.4fr .7fr .7fr 70px`（行 68px：34px 厂商 logo 格 + 名称/接口 pill + 28×16 开关 on `#2582f7`）、二级编辑弹窗 560px（vendor 双列 + 字段双列 + 高级折叠）。现有 ChannelManager 能力（预设填 Key/测试连接/拉取模型）全部保留装入。composer 模型选择器：300px popover + 行内 ReasoningEffortSlider（映射思考等级 ○◔◑●）。
- **命令体系**：SlashCommandMenu（`slash-menu.ts` 64 + `CommandPalette/` 79）从 composer 顶部上浮（圆角 10、`0 15px 40px #1d263224`、宽 min(820px,100%)、max-height min(334px,42vh)、「命令/技能」两分组 + 计数、行 = 22×22 图标格 + 等宽 `/name` + 灰描述 + CornerDownLeft、footer kbd 提示）；⌘K 命令中心保留，套同款弹层皮。
- **UserQuestionComposer**（普通提问卡，182 行）：800px 白卡接管 composer（uppercase eyebrow + 问题 h2 + 「Agent 正在等待你的回答」、radio/checkbox 26px 编号圆/方、选中绿勾 + 3px 左绿条、推荐项绿 chip、自定义回答 textarea、footer 题号 pager + 停止红钮 + 跳过 + 黑底「提交回答」）。接现有 question 事件；若主进程无此事件则组件就位不激活。

## 7. 品牌与 i18n

- Logo：根目录 `LaboFlow Logo_Square_1.svg`（构建时拷入 renderer assets）；SztuCode 表情 AgentLogo 不移植，所有头像位用 LaboFlow 方形 Logo。
- hero 文案提案：标题「Think it. Deliver it.」；输入占位「所思，皆成交付」（用户可随时改，位置集中在语言包）。
- i18n：以 SztuCode `zh-CN/app.ts|timeline.ts|session.ts|composer.ts` 文案为基准建 keys（新建任务/全部任务/自动化/技能/浏览器连接/查看过程 · {duration}/正在规划下一步/步骤 {current} / {total}/标准审批/全部允许/…全套），en.ts 同步；清理第四轮新增硬编码中文（ChatView MODE_DESCRIPTIONS、SettingsPage 标题、ui-bits、UsageStatsPage 等）。

## 8. 随手修复（重设计依赖项）

1. `store.ts:397` 后台会话事件丢弃 → **按会话缓存**（turn 折叠回放与切回体验依赖；缓存上限对齐现有滑窗 120 条/会话）。
2. font-scale 冲突统一 0.95/1.05/1.15。
3. 删死代码：旧 `SettingsDialog.tsx`（376 行无引用）、`ContextPanel.tsx` 空壳。
4. 弹层原语统一：3 处 Radix Dialog + N 处手写 overlay → 一套 popover/dialog 原语组件（Radix），全站复用。
5. Markdown 补 highlight.js 高亮。

## 9. 测试与验收

- **tokens 漂移测试**：扩展 `packages/ui` tokens.test.ts 锁 v4 全部值。
- **既有测试全绿**：composer-triggers 12 用例必须保持通过（触发器逻辑不动）。
- **新增 Vitest 组件测试**：turn 分组纯函数、ActivityPhase 状态机、审批条五档映射、QueueDock 行为、store 后台事件缓存。
- **data-testid**：全量保留 + 新结构补齐，延续截图验收文化。
- **逐屏验收**：对照 SztuCode 四截图（首页/会话/分屏 Inspector/技能页）区域级比对（尺寸差 ≤4px、色值 ΔE≤3、圆角字号一致）+ 暗色主题全屏巡检 + 空态巡检；新截图入 `current/`。
- 回归红线：主进程零改动（diff 审查 `apps/desktop/src/main`、`packages/shared` 必须为空）；`pnpm build` 与现有 Vitest 全绿。

## 10. 里程碑

| 阶段 | 内容 | 出口 |
|---|---|---|
| M1 | tokens v4 + Shell（标题栏/侧栏/五项导航/项目树/页脚）+ landing hero | 应用可跑，侧栏与首页对照截图一致 |
| M2 | 会话时间线（turn/ActivityPhase/ToolCall/审批融合/统计行/圆点导航）+ Dock composer + QueueDock | 会话全程对照截图一致，composer-triggers 全绿 |
| M3 | Inspector 分屏（5+5 tab）+ board + 技能页（插件\|技能双 tab） | 分屏与技能页对照截图一致 |
| M4 | 自动化页 + 浏览器连接页(MCP) + 设置 Dialog + 模型管理 + ⌘K/slash 皮 | 全功能可用 |
| M5 | 空态三件套 + 暗色主题 + i18n 清理 + 死代码删除 + 全屏截图验收 | §9 全部通过 |
