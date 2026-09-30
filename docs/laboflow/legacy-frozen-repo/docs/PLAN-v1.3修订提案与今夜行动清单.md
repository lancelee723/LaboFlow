# LaboFlow 进度盘点 · PLAN/SPEC 修订提案（v1.3）· 今夜行动清单

- 日期：2026-09-06 深夜
- 性质：**提案文档，待批准后开工**；批准后其中的 PLAN/SPEC 修订内容合入正式文档
- 输入：①PRD v1.2 ↔ PLAN v1.2 ↔ SPEC v1.2 ↔ 当前实现三方对照；②《LaboFlow bug和新增需求反馈清单》（17 项）；③今夜（00:00–09:00，约 9h）行动计划

---

## 一、三方对照盘点（PRD ↔ PLAN/SPEC ↔ 实现）

### 1.1 已完成且通过验收（摘要）

P0 全部；P1 批次 A–D/H（含 T1.22 引擎 worker 化、T1.23 产物工作台）；P1 批次 E/F（T1.12–T1.21）；P4 全部（远程/RC/Bot/Headless/OAuth 脚手架）；P2 服务端 T2.1–T2.10（骨架/认证/RBAC/网关/配额/工作区/交付物/资产库/管理台/登录下发）；客户端 T2.11–T2.15 精简版；批次 G/I 的**服务核心**；UI 批次 B1/B2/B3核心/B5核心；U.1 图标；273 测试。

### 1.2 ★「服务已建、用户价值未打通」半成品清单（本轮重点缺口）

这批的特征是：后端服务与测试齐全，但**没有接入会话主流程或没有 UI 入口**，用户实际感知为零。

| # | 项 | 已有 | 缺口（打通工作） | 对应 PRD |
|---|---|---|---|---|
| H1 | **思考等级** | sessions.thinking 列、UI 循环显示、引擎方法 setThinkingLevel 已在 RPC 方法集 | **从未传入引擎——确认是"安慰剂"**（反馈 #8 的怀疑属实）：prompt 链路无 thinking 参数，EngineHost prompt 未传 thinkingLevel | FR-C-04 |
| H2 | **Goal Mode** | GoalService（状态机/逐轮校验/预算） | agent_settled 后不调 beginVerification；无 /goal 命令注册；无 goal card UI | FR-C-39 |
| H3 | **Memory** | MemoryService（事实文件/索引/意图解析） | prompt 前不注入召回索引；「记住/忘掉」意图不拦截；无管理页 | FR-C-41 |
| H4 | **Wiki** | WikiService（隐私过滤/逐页/隔离） | 文件树无生成入口；无阅读器 | FR-C-40 |
| H5 | **深度研究** | ResearchService（计划/检索/综合） | 无 /research 命令与 UI 入口 | FR-C-53 |
| H6 | **Slide 引擎** | SlideService（真实 PPTX 导出） | 无生成入口与预览 | FR-C-52 |
| H7 | **消息中心** | NotificationService + 表 + IPC | 无人 emit（调度器用自己的桌面通知）；无铃铛/列表 UI | FR-C-58 |
| H8 | **组织配额余量** | bootstrap policyFloor 已下发 | 无余量展示 UI | FR-C-22 |

### 1.3 PRD 有、PLAN 排了、**未做**的

| 项 | PRD/PLAN 位置 | 状态 |
|---|---|---|
| MCP OAuth 完整接入 UI | FR-C-42 / T2.19 | 交换函数+单测已建，MCP 配置 UI 未接 OAuth 流 |
| 双清单 userConfig 注入 | FR-C-43 / T2.20 | helpers 已建，marketplace 安装链路未接 |
| 定时任务结构化频率选择器 UI | FR-C-18 / T1.12 | 服务端支持 daily/weekly/monthly/once/cron，**UI 只有分钟/小时 interval** |
| Computer Use | FR-C-24 / T3.1 | 未开始（P3） |
| 闲时任务 | FR-C-46 / T3.8 | 未开始（P3） |
| Hooks 完整协议 | FR-C-47 / T3.3 | 未开始（P3） |
| 圆桌讨论轮 / 组织专家库 | FR-C-16/17 / T3.2 | 未开始（P3） |
| 60fps 渲染实测 | SPEC §9 | 数据层压测已过，渲染 trace 未跑 |
| 真实三供应商接入 | Gate P1 外部项 | 待 API Key（外部） |

### 1.4 PRD 有、**被排除/降级**的（含本次反馈新增，需 PLAN v1.3 正式收编）

| 项 | 来源 | 提案处置 |
|---|---|---|
| 会话归档机制 + 归档记录页 | **反馈 #5**（新增，参考 Cortex） | 收编进 P2 客户端批次（本提案 N5，今夜做核心） |
| Claude 官方市场为默认源 | **反馈 #11** | 收编（今夜做，小） |
| Clawhub.ai 在线 Skill 搜索安装 | **反馈 #12** | 收编为 P2 新任务（市场源插件化，非今夜） |
| 模型设置页 Cortex 式重做 | **反馈 #13** | 收编为 B3 深化主项（大，非今夜全部） |
| 个人资料页（用户名/头像） | **反馈 #14** | 收编（本地 profile，P2 客户端） |
| 通用页复刻 Cortex | **反馈 #15** | 收编（设置页改造的一部分） |
| 全局字号 大/中/小 | **反馈 #16** | 收编（token 层加 font-scale） |
| Composer ＋菜单（附件/@///能力/!技能） | **反馈 #17** | 收编（composer 改造） |
| 桌面宠物/禅模式/做梦 | Cortex 特性 | 维持排除 |

### 1.5 本次反馈 17 项 → 处置映射（汇总）

| # | 反馈 | 类型 | 根因/方案 | 处置 |
|---|---|---|---|---|
| 1 | 暗黑模式 Logo 融底 | Bug | 单一 SVG 黑字；方案 B：白底圆卡包裹（全主题一致） | **今夜 W1** |
| 2 | 首开浮层背景半透明 | Bug | **根因**：主题 CSS 变量靠 MutationObserver 应用，浅色首开时类名不变→变量从未注入→`var(--bg-card)` 无值。修复：styles.css `:root` 写入全部浅色缺省值 + 挂载时主动 applyThemeVariables() | **今夜 W1**（#7 同根因同修） |
| 3 | 引擎横线+文字删除 | Bug | 删 Sidebar 底部行 | **今夜 W1** |
| 4 | 侧栏 tab 改 ZCode 形制 | 改进 | tab 收敛为 分组/项目 两项+浅灰胶囊框+白/黑选中浮起；右侧「筛选和排序」图标 → 视图（项目/时间线）+ 排序（更新时间/创建时间）菜单 | **今夜 W2** |
| 5 | 会话归档机制 | 新功能 | sessions.status='archived' + hover 归档钮 + 设置「归档记录」页（按项目/时间，真删除） | **今夜 W3（核心）** |
| 6 | 自动化跳转错误/存疑 | Bug | 深链 settings+section=automation；调度器已实现（croner），补自动化面板真实任务列表即可证明 | **今夜 W1** |
| 7 | 权限钮半透明 | Bug | 同 #2 根因 | **今夜 W1** |
| 8 | 思考按钮重复+安慰剂 | Bug+改进 | 仅保留发送钮旁「🧠 等级 ▾」；**后端真接线**：sessions.thinking → EngineHost prompt 参数 → Pi setThinkingLevel；mock 驱动同步生效 | **今夜 W3** |
| 9 | 顶部 Banner 删除 | 改进 | 删横条；辅助对话/撤销/分叉/导出迁入「···」溢出菜单与输入卡 | **今夜 W2** |
| 10 | 项目下无法新建会话+骨架闪动 | Bug | 会话列表加每项目「＋」；骨架条件改为仅首次加载（loaded 标志） | **今夜 W1** |
| 11 | Claude 市场默认源 | 新功能 | MarketplaceService 预置官方 Claude marketplace 清单源 | **今夜 W4** |
| 12 | Clawhub Skill 市场 | 新功能 | 新市场源适配器（搜索/下载/安装） | P2-新增（非今夜） |
| 13 | 模型设置页 Cortex 式重做 | 改进 | 默认模型双下拉+供应商分组卡片（订阅登录/API Key/自定义）+套餐卡 | B3 深化主项（明日批次） |
| 14 | 个人资料页 | 新功能 | 本地 profile（用户名/头像）设置页+会话顶部头像替换 | P2-新增（明日批次） |
| 15 | 通用页复刻 Cortex | 改进 | 设置常规页按 Cortex 项重排 | 明日批次 |
| 16 | 字号大一号+三档设置 | 改进 | token 层 --font-scale ×3 档，html font-size 16/17.5/19 | **今夜 W2**（含默认+1） |
| 17 | Composer ＋菜单 | 改进 | ＋号弹出菜单：附件/@ 添加上下文（聚焦已有弹窗）// 命令/！技能 | **今夜 W2** |

---

## 二、PLAN v1.3 修订提案（批次重排）

在 PLAN v1.2 基础上新增/调整以下批次（已完成批次不动）：

### 新增批次 J：体验修复与对齐冲刺（响应反馈 #1–#10、#17，约 1 周）
- J1 全局主题变量修复（#2/#7 根因）：styles.css :root 缺省值 + 挂载注入。— 验收：首开浅色主题下 ModeSelector/命令中心/用户菜单背景不透明。
- J2 Logo 白底卡（#1，方案 B）。— 验收：暗色下 Logo 清晰。
- J3 侧栏清理与 tab 重做（#3/#4）：删引擎行；tab=分组/项目 + 筛选排序菜单（视图：项目/时间线；排序：更新时间/创建时间）。
- J4 顶栏 Banner 移除与功能迁移（#9）＋ Composer ＋菜单（#17）。
- J5 项目内新建会话 + 骨架修复（#10）＋自动化深链（#6）。
- J6 思考等级真接线（#8 后端）：sessions.thinking → RunInput.thinking → EngineHost prompt → Pi setThinkingLevel；mock 驱动在回复前缀输出思考档验证。
- J7 会话归档机制（#5）：status='archived'、hover 归档钮、设置「归档记录」页（筛选+真删除）。
- **Gate J**：反馈 #1–#10、#17 全关闭；273+ 测试绿；E2E 绿；截图比对。

### 调整批次 B3+/B5+（并入明日）
- B3+：模型设置页 Cortex 式重做（#13，含默认模型双下拉/供应商分组卡片/套餐卡）＋通用页复刻（#15）＋个人资料页（#14）＋字号三档（#16）。
- B5+：热力图/峰值/最长会话；组织配额余量卡（H8）。

### 新增批次 K：半成品价值打通（H1–H8 中未含于今夜者，约 1.5 周）
- K1 Goal 打通（/goal 命令 + agent_settled 校验续跑 + 右栏 goal card）。
- K2 Memory 打通（召回注入 + 意图拦截 + 管理页）。
- K3 Research UI（/research + 报告产物化）。
- K4 Slide UI（$slides + 预览导出）。
- K5 消息中心 UI（铃铛 + 列表 + 调度器/审批 emit 接线）。
- K6 Clawhub Skill 市场源（#12）。
- K7 Wiki 入口与阅读器。
- **Gate K**：每项以「用户可见操作闭环」验收（如 /goal 设定目标→两轮自动续跑→达成收尾）。

### 里程碑影响
- P2 Gate 新增：批次 J/K 验收通过；模型设置页重做验收。
- P3 范围不变（Computer Use/闲时/Hooks/圆桌 等）。

---

## 三、SPEC v1.2 增补提案（实现侧）

1. **§4.2 AgentService**：RunInput 增加 `thinking: 'off'|'low'|'medium'|'high'`；EngineHost `prompt.params.thinkingLevel`；Pi `setThinkingLevel` 在会话建立/变更时调用。mock 驱动回显档位。
2. **§4.12 GoalService**：新增「接线」——AgentService 在 agent_settled 后调用 `goals.beginVerification`，continueRun 时以 verificationPrompt 自动 followUp；`/goal` 注册为命令（CommandService builtin）。
3. **§4.13 MemoryService**：`before_prompt` 注入 recallIndex（≤8KB）；输入解析层先于引擎拦截 记住/忘掉/列出 意图（不耗模型轮次）。
4. **§4.5 数据模型**：sessions.status 枚举扩展 `'archived'`；归档记录页读 `status='archived'`，删除=真删除（级联 entries/FTS）。
5. **§新增 ProfileService**：本地 profile（displayName/avatar 路径）存 kv；头像文件存 userData。
6. **§新增 MarketSources**：marketplaces 预置官方 Claude 源；新增 Clawhub 源适配器接口（search/list/download）。
7. **§4.10 前端**：全局 `--font-scale`（小 0.95 / 中 1.05（默认，含整体 +1 号）/ 大 1.15），html font-size = 16 × scale。
8. **主题变量应用时机**：cssVariables 缺省值内联进 styles.css `:root`（浅色），暗色由 .dark 覆盖 + JS 注入——消除首开透明类 bug 的结构性根因。

---

## 四、今夜行动清单（v2 加倍版：00:00–09:00，12 个 Wave，等效约 18h 工作量）

> 原版 6 Wave（9h）全部保留，并提入原「明日批次」与批次 K 的全部核心项。执行纪律不变：每项完成即自验，单项超时 30 分钟记录跳过；每 3 个 Wave 插一轮全量门禁（lint/typecheck/test/build），E2E 在 W12 终验。原「明日批次」中未完成者顺延次日，但今夜目标为全部清零。

### Wave 1 体验根因修复（约 1.5h）
| # | 任务 | 验收 |
|---|---|---|
| W1.1 | styles.css `:root` 注入 Token v3 全量浅色缺省值；App 挂载主动 applyThemeVariables() | 首开浅色下模式菜单/命令中心/用户菜单背景纯白不透明（#2/#7 根因） |
| W1.2 | Logo 白底卡包裹（img 套白色圆形底，全主题一致） | 暗色下 Logo 文字清晰（#1 方案 B） |
| W1.3 | 删除侧栏底部「引擎」横线与文字 | 侧栏底部无该行（#3） |
| W1.4 | 顶栏 Banner 删除；辅助对话/撤销/分叉/导出迁入「···」溢出菜单；条目数移除 | 顶栏仅剩权限+分屏钮，功能全可达（#9） |

### Wave 2 侧栏与 Composer（约 2h）
| # | 任务 | 验收 |
|---|---|---|
| W2.1 | 侧栏 tab 重做：仅「分组 / 项目」两枚胶囊入浅灰（暗：深灰）底框，选中白/黑浮起 | 与 ZCode 主界面同构（#4-A） |
| W2.2 | 右侧「筛选和排序」图标 → 菜单：视图（项目/时间线）+ 排序（更新时间/创建时间），排序真实生效 | 切换排序列表顺序变化（#4-B） |
| W2.3 | 项目内新建会话：会话行 hover 常驻＋钮；空项目显示空态+新建钮；骨架仅首载显示（store loaded 标志） | 新建项目后立即可建会话，无永久骨架（#10） |
| W2.4 | Composer ＋菜单：附件 / @ 添加上下文 / ／ 命令 / ！技能（列出已启用技能，选中插入 $name） | 四入口全可用（#17） |

### Wave 3 后端真接线（约 1.5h）
| # | 任务 | 验收 |
|---|---|---|
| W3.1 | 思考等级真接线：AgentService.setThinking → sessions.thinking 落库 → RunInput.thinking → EngineHost prompt 透传 → Pi setThinkingLevel；删除左下重复思考钮，仅留发送钮旁「🧠 等级 ▾」 | mock 回复前缀含当前档位；UI 单一入口（#8） |
| W3.2 | 自动化深链 + 可用性证明：store.pendingSettingsSection；自动化行直达自动化面板；面板真实任务列表+立即运行+记录刷新 | 建任务→立即运行→记录 ok（#6） |

### Wave 4 会话归档机制（约 1.5h）
| # | 任务 | 验收 |
|---|---|---|
| W4.1 | AgentService.archive/restore/hardDelete；列表默认过滤 archived | hover 出归档钮；归档后主列表消失 |
| W4.2 | 设置「归档记录」分区：按项目分组+时间排序，恢复+真删除（二次确认级联 entries/FTS） | 归档页可恢复/真删（#5） |

### Wave 5 Claude 默认市场（约 0.5h）
| # | 任务 | 验收 |
|---|---|---|
| W5.1 | MarketplaceService 首启预置官方 Claude 市场源；插件页可见可装 | list-all 含该源（#11） |

### Wave 6 中场门禁（约 0.5h）
- lint 0 error / typecheck 五包 / test 全绿 / build；W1–W5 截图入 docs/design/current/。不绿则先修复再进。

### Wave 7 模型设置页 Cortex 式重做（约 2.5h，#13 主项）
| # | 任务 | 验收 |
|---|---|---|
| W7.1 | 页骨架：默认模型双下拉（供应商+模型，仅列已配置）+ 供应商计数 + 搜索框 | 与 Cortex参考图4 结构一致 |
| W7.2 | 供应商分组 tabs：订阅登录 / API Key / 云平台 / 自定义（首版：API Key+自定义有内容，订阅登录卡显示「登录」钮占位接 P4 OAuth） | 分组切换正确 |
| W7.3 | 供应商卡片：图标+名+已启用绿徽+模型数胶囊+「填写 Key/登录」操作；点击展开配置（Key/BaseUrl/拉模型） | 添加 GLM→保存→模型列表出现 |
| W7.4 | 旧渠道管理对话框退役，入口全部指向本页 | 无双入口残留 |

### Wave 8 通用页复刻 + 个人资料（约 1.5h，#14/#15/#16）
| # | 任务 | 验收 |
|---|---|---|
| W8.1 | 通用页按 Cortex 项重排：语言/主题/缩放/启动行为/数据目录/自动继续 | 全项可见可操作（#15） |
| W8.2 | 个人资料页：用户名+头像（本地上传→userData 存储 kv 引用）+顶栏/用户条头像替换 | 改头像后侧栏立即变化（#14） |
| W8.3 | 字号三档：--font-scale 小/中/大（默认中=现 UI+1 号），外观页新增选择并持久化 | 切换即时全局生效（#16） |

### Wave 9 批次 K 打通·上（约 2h）
| # | 任务 | 验收 |
|---|---|---|
| W9.1 | Goal 打通：/goal 注册命令；agent_settled → beginVerification → continueRun 自动 followUp；达成标记 done；右栏工作台顶部 goal card（目标/轮次/暂停清除） | 设目标后自动续跑两轮并收尾（K1） |
| W9.2 | Memory 打通：prompt 前注入 recallIndex；「记住/忘掉/列出」意图先于引擎拦截直写；设置新增记忆管理页（列表/删除） | 记住→新会话召回可见；忘掉→删除（K2） |

### Wave 10 批次 K 打通·下（约 2h）
| # | 任务 | 验收 |
|---|---|---|
| W10.1 | 通知中心：调度器/审批/配额告警 emit 到 NotificationService；顶栏铃铛+未读数+列表页（已读/跳转） | 任务完成产生通知并可跳转（K5） |
| W10.2 | Research UI：/research 命令 + 产物化报告打开预览 | 一条命令产出带引用报告（K3） |
| W10.3 | Slide UI：$slides / 「生成 PPT」chip → 大纲 → 导出 PPTX 产物卡片 | 一句话产出可下载 PPTX（K4） |
| W10.4 | Wiki 入口：项目文件树顶「生成 Wiki」→ 过程态 → 阅读器（wiki.json 渲染） | 生成后可阅读（K7） |

### Wave 11 收尾补全（约 1.5h）
| # | 任务 | 验收 |
|---|---|---|
| W11.1 | Clawhub Skill 市场源：市场源适配器 + 技能页「在线搜索」tab（搜索/安装） | 搜到并安装一个真实技能（K6/#12；外网不可达则登记外部待办） |
| W11.2 | B4 补全：MCP 分区启动/停止钮、插件分区卸载确认、专家分区编辑入口 | 与 ZCode 管理页同构 |
| W11.3 | 自动化频率选择器 UI 补全：日/周/月/一次性 + 点位选择（服务端已支持） | 建每日 09:00 任务成功（FR-C-18 UI 补全） |

### Wave 12 终验门禁（约 1h）
- 全量：lint 0 error / typecheck 五包 / test 273+（新增归档/思考/菜单测试）/ build / E2E PASS
- 运行实例全页截图（工作台/设置全页/模型页/统计/归档/通知）入 docs/design/current/
- PLAN v1.3 与 SPEC 增补正式合入正式文档；P2 进度报告追加第五批记录
- 更新《工作回顾与差距分析》：差距清单与反馈 17 项逐条标记关闭状态

### 时间预算汇总
W1 1.5 + W2 2 + W3 1.5 + W4 1.5 + W5 0.5 + W6 0.5 + W7 2.5 + W8 1.5 + W9 2 + W10 2 + W11 1.5 + W12 1 ≈ **18h 等效工作量**（ agent 连续执行，00:00–09:00 目标清零全部反馈与批次 K）。

## 五、风险与说明

1. 反馈 #5（清单第 5 条）在笔记中未写完（“左侧工作区总tę...”截断）——已按可推断部分（归档机制）处理，如有遗漏请补充。
2. 思考等级接线涉及 Pi SDK 行为：`setThinkingLevel` 为引擎 RPC 已有方法，若 Pi 侧对 mock 模型不支持档位差异，则以「引擎参数已传递 + 日志可证」为验收，真实档位效果待接真实模型复核。
3. W2.4 字号默认「中=现 UI+1 号」将整体放大视觉，可能与像素比对基线冲突——按用户要求执行，比对基线随本次反馈同步更新。
4. 今夜不动服务端 API 结构（除 usage 聚合外均已有）；归档/字号/菜单均客户端闭环。
5. （加倍版）Wave 7–11 依赖 Wave 1–6 的地基先绿：若中场门禁不过，跳过 Wave 7 优先修复，批次 K（W9–W10）可顺延次日但 Wave 7 模型页为保证项。
6. 外部依赖项（Clawhub 真实网络、订阅 OAuth 凭据）不可达时以「UI+适配器就绪+登记外部待办」验收，不算失败。
7. 字号默认「中=现 UI+1 号」执行后，像素比对基线随反馈同步更新（用户已确认）。
