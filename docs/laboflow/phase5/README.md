# Phase 5 重规划：高级功能模块群（总览与裁决记录）

| 文档属性 | 内容 |
|---|---|
| 日期 | 2026-09-11 |
| 状态 | 草案，待评审 |
| 范围 | 取代 `02-org-integration-plan.md` 中 Phase 5「咨询层特性回迁」的原一句式规划，改为六个独立立项的高级功能模块 |
| 前置 | Phase 2（组织脊柱）✅、Phase 3（组织渠道与配额）✅；Phase 4（共享工作区）未启动 |
| 人力假设 | 沿用 PLAN v1.2：2 名全职工程师（1 前端向 + 1 全栈向）+ 1 名兼职设计 |

## 1. 模块清单与映射

用户需求清单（2026-09-11）拆解为六个独立立项模块，每个模块独立成套 PRD / PLAN / SPEC：

| # | 模块目录 | 名称 | 对应需求 | 一句话定位 |
|---|---|---|---|---|
| 01 | `01-expert-center/` | 专家与专家团 | 需求 1.1 | 「人设 + 方法论 + 工具链」的**独立 Agent**（区别于子代理）与专家团编排，对标 Workbuddy 专家中心 |
| 02 | `02-team-collab/` | 多人多 Agent 协作（团队空间） | 需求 1.2 | 资料库团队空间：权限四档、MD 划词评论与 AI 修订建议、HTML 协同编辑 |
| 03 | `03-mobile-command/` | 手机远程指挥与定时任务 | 需求 2 | 助理模式总控台 + 通用 Webhook + cron 定时任务（含补跑语义） |
| 04 | `04-im-channels/` | 接入 IM 工具 | 需求 3 | 飞书机器人 / 企业微信机器人 / 微信公众号 三通道适配层 |
| 05 | `05-knowledge-base/` | 接入知识库 | 需求 4 | WeKnora 等知识库以 MCP 接入 + 内嵌浏览器打开知识库网页端 + 组织统一下发 |
| 06 | `06-ppt-assistant/` | 高级 PPT 制作助手 | 需求 5 | L1 pptxgenjs 基线回迁 + L2 PPT-Master 技能集成 + L3 幻灯片工作台 |

> 说明：需求 1 原文含 1.1（专家与专家团）与 1.2（多人多 Agent 协作）两个差异极大的子域——前者是角色封装与编排，后者是服务端文档协同（评论/修订/权限），合并立项会使 PRD 失焦，故拆为 01、02 两个模块。02 依赖 Phase 4 共享工作区先行。

## 2. 共享架构前提（现状盘点，2026-09-11 勘察结论）

新仓库（PI-Desktop v0.14.5 fork）已有的地基与缺口，六个模块的 SPEC 均以此为出发点：

**可直接复用的地基**

- 子代理体系：`~/.agents/subagents/<name>.md` 定义（frontmatter + body 即系统提示词）、`Task/TaskWait/TaskStop/TaskList` 工具、设置页 `AgentSubagentsPage` 与工作面板 `SubagentPanel`（模块 01 的运行时底座）。
- MCP 体系：`mcp_servers.rs` + `UserMcpRuntime`（stdio/http 传输、静态 env/headers 鉴权、ADR-0142 允许非环回 HTTP）（模块 05 的接入底座）。
- 内嵌浏览器：`browser-view.ts`（主进程 WebContentsView，partition `persist:work-browser`）+ `pi.browser` 工作面板标签（模块 05 的网页端通道）。
- 插件体系：`contributes.commands/agentTools/skills/settings/mcpServers/services/views`（模块 06 的承载形态，参照 `pi.browser` 先例）。
- 组织层：`org-service.ts` 登录/bootstrap 下发/组织渠道注入/配额面板（模块 01/04/05/06 的组织下发通道）。
- 服务端：`apps/server` 工作区/回合锁/条目序号增量同步/交付物库 20 版滚动（模块 02 的服务端底座，Phase 4 客户端未接）。

**必须补建的地基缺口（各模块认领）**

| 缺口 | 现状 | 认领模块 |
|---|---|---|
| Headless 执行驱动 | 仅渲染进程能发起回合（`sendPrompt` → IPC → sidecar）；`scheduled.run` 建会话后等 UI 发提示词 | **共享地基 T53.1**（03 立项、01 的后台专家会话与 04 的通道任务共用，建议最先合入主干） |
| 专家独立会话执行 | 专家=独立 Agent（用户概念裁决 R5-9），后台派发需程序化启动独立会话 | 01（复用 T53.1，不自建第二套后台机制） |
| 调度器定时器与 cron | `scheduled.rs` 的 cadence 只是存储标签，无任何触发逻辑；无 cron 表达式 | 03（T53.2） |
| 本地 HTTP 服务 | 主进程无任何 `createServer`（通用 Webhook / iOS 快捷指令需要） | 03（T53.3） |
| IM 通道层 | 无飞书/企微/微信代码；冻结仓库 BotBridge 仅有库方法（信封解析/签名校验），无监听器与服务端中继 | 04 |
| Agent 间协作 | ADR-0165 已撤回 A2A（host-core `a2a` 模块删除）；今日子代理只能向父会话汇报 | 01（以「编排器星型模型」替代，不重建 A2A） |
| 文档协同 | 服务端仅有共享会话条目流，无文档树/评论/修订建议模型 | 02 |
| PPT 能力 | 零（pivot 决策暂不移植 SlideService） | 06 |

## 3. 依赖图与启动顺序

```
共享地基 T53.1 HeadlessAgentDriver（最先合入；01 后台专家会话 / 03 定时与远程 / 04 通道任务共用）
        │
        ├──> 01 专家与专家团（M-E1 召唤无依赖；M-E2 派发依赖 T53.1）──（PPT制作师联动）──> 06 PPT助手
        │
03 远程指挥+定时任务 <──通道依赖── 04 IM通道（03 的 T53.3 通用 Webhook 不依赖 04）
05 知识库（独立，仅依赖既有 MCP + browser-view + 组织下发）

Phase 4 共享工作区（前置，未启动）
        └──> 02 多人多Agent协作（最大单块，最后启动）
```

**建议启动顺序**（价值 × 依赖 × 风险综合，2 人团队串行为主）：

1. **01 专家与专家团**（约 5–6 周）：M-E1（专家中心+召唤）建在既有能力档案与启动装配机制上，无新地基；预设专家（战略规划分析师/PPT 制作师/数据分析专家）即刻可用；M-E2（@指派/专家团）依赖 T53.1。
2. **06 PPT 助手**（约 7–8 周）：咨询交付核心；L1 基线可两周内回迁保底，L2 PPT-Master 集成是本模块主菜。
3. **05 知识库**（约 3–4 周）：体量最小，MCP 与内嵌浏览器均现成，主要是组织下发与体验打磨。
4. **04 IM 通道 → 03 远程指挥**（合计约 10–11 周，可部分并行）：03 的 T53.1 headless 驱动与 T53.3 通用 Webhook 先行（不依赖 04），随后接飞书（WS 长连接，免公网，工程风险最低）→ 企微智能机器人 → 微信公众号（需服务端中继）。
5. **02 多人多 Agent 协作**（约 10–12 周）：依赖 Phase 4 客户端落地后启动，服务端扩展可提前设计。

> 若市场侧强推移动指挥，可将 04+03 提到 06 之前；**T53.1（HeadlessAgentDriver）无论如何最先合入**——它是 01 的后台专家派发、03 的定时/远程任务、04 的通道任务的共同底座，也是唯一需要触碰主干会话启动路径的改动（R5-10 触点清单之首）。

## 4. 跨模块裁决记录

| # | 裁决 | 说明 |
|---|---|---|
| R5-1 | **推翻 pivot 决策中的调度语义**：scheduler 引入 5 字段 cron 表达式与「错过补跑」语义（只补最近一次 / 24h 上限 / 首启不补 / 不叠跑 / 可关），不再沿用 manual/hourly/daily/weekly 标签 | 用户需求 2.2 明确要求；Rust 侧 `scheduled.rs` 扩展 |
| R5-2 | **不重建 A2A**：专家团协作采用「编排器星型模型」（TeamRunner 在主进程拆解→并行派发子代理→整合），agent 间不直接通信 | ADR-0165 撤回教训：跨会话寻址复杂度高、收益低；星型模型覆盖 90% 团队场景 |
| R5-3 | **知识库不进桌面端进程**：WeKnora 由用户/组织自行部署，桌面端仅 MCP 接入 + 内嵌浏览器打开网页端 | 用户明确裁决（工程量与资料保密）；组织下发 MCP 配置走 bootstrap |
| R5-4 | **PPT-Master 以技能包形态 vendor 集成**（MIT，pin 固定版本，规避 PyMuPDF AGPL 路径），不 fork 其代码、不包装成独立服务；同时保留 L1 pptxgenjs 基线作为轻量保底 | 详见 `06-ppt-assistant/` 三件套对两个关键问题的回答 |
| R5-5 | **微信通道采用公众号官方路线**（认证服务号/测试号 + 服务端中继回调），明确不做任何非官方个人号协议 | 合规红线；详见 `04-im-channels/PRD.md` §微信通道裁决 |
| R5-6 | **无人值守权限策略三档**（严格/降级挂起/宽松），headless 会话默认「严格」（ask 类工具调用自动拒绝并记录），IM 触发的会话默认「降级」（挂起 + 推送审批） | 既有三档权限（ask/accept-edits/auto）面向交互场景，headless 必须显式定义 ask 的去向 |
| R5-7 | 模块 02 的 HTML 多人同时编辑 v1 采用 **Yjs CRDT**（服务端 y-websocket provider），MD 文档采用**服务端权威 + 评论/修订建议制**（不引入 CRDT） | MD 的核心体验是「建议-审阅-接受」，天然不需要并发合并；HTML 直接改才需要 |
| R5-8 | 组织资产下发统一走 `/org/bootstrap` 扩展字段（expertPacks / kbServers / slideTemplates / imRelay），不在客户端做组织资产 CRUD | 与 Phase 2/3 既有的组织渠道下发模式一致 |
| R5-9 | **专家是独立 Agent，不是子代理**：专家以独立会话执行（前台召唤/后台 headless 派发），拥有会话级完整工具链（专家声明 ∩ 权限模式）；PI-Desktop 子代理机制（定义/`SUBAGENT_ASSIGNABLE_TOOLS` 白名单/Task 工具族/面板）保持原语义零改动，继续服务「任务内并发代理」场景 | 用户概念裁决（2026-09-12）：子代理=任务内处理部分事务的并发代理；专家=可独立承接完整任务的 Agent。两者不得混淆实现 |
| R5-10 | **插件优先与最小侵入**：凡能以 bundled plugin + `contributes`（agentTools/skills/views/settings/mcpServers/services）承载的能力**不得改主干**（PPT 模块 06 整体插件化为范本）；数据/定义存储优先复用 PI-Desktop 既有惯例（`.agents/<kind>/` 定义文件、`mcp_servers` 唯一 MCP 注册表、kv 存储），**不建平行注册表、不造新标准**；对主干的必要改动收敛在本 README §2 缺口表所列各项，每项在模块 SPEC 中列出触点清单 | 避免对 PI-Desktop 本体的侵入式修改与上游漂移冲突 |

## 5. 文档索引

| 模块 | PRD | PLAN | SPEC |
|---|---|---|---|
| 01 专家与专家团 | [PRD](01-expert-center/PRD.md) | [PLAN](01-expert-center/PLAN.md) | [SPEC](01-expert-center/SPEC.md) |
| 02 多人多 Agent 协作 | [PRD](02-team-collab/PRD.md) | [PLAN](02-team-collab/PLAN.md) | [SPEC](02-team-collab/SPEC.md) |
| 03 远程指挥与定时任务 | [PRD](03-mobile-command/PRD.md) | [PLAN](03-mobile-command/PLAN.md) | [SPEC](03-mobile-command/SPEC.md) |
| 04 接入 IM 工具 | [PRD](04-im-channels/PRD.md) | [PLAN](04-im-channels/PLAN.md) | [SPEC](04-im-channels/SPEC.md) |
| 05 接入知识库 | [PRD](05-knowledge-base/PRD.md) | [PLAN](05-knowledge-base/PLAN.md) | [SPEC](05-knowledge-base/SPEC.md) |
| 06 PPT 制作助手 | [PRD](06-ppt-assistant/PRD.md) | [PLAN](06-ppt-assistant/PLAN.md) | [SPEC](06-ppt-assistant/SPEC.md) |

外部调研底稿（本目录 `research/`）：Workbuddy 功能模型、WeKnora / PPT-Master 项目调研、飞书/企微/微信机器人官方 API 概览。

## 6. 验收基准与横切要求

- 每个模块 PLAN 末尾的 Gate 为合入门禁；跨模块回归（lint / typecheck / 既有 E2E 三平台矩阵）在每次 Gate 复跑。
- **主干触点管控（R5-10 落地机制）**：各模块 SPEC 须列出对 PI-Desktop 主干（`electron/main/index.ts`、host-core、`packages/shared`）的全部触点清单；无清单的改动不得合入。当前已知主干触点仅：T53.1（会话启动路径重构，共享地基）、host-core 各迁移（v14 起按**实际合入顺序**顺延——文中 v14/v15/v16 为规划序，模块 01 已取消其迁移）、渲染层页面联合类型/设置 tab/侧栏入口的既有三件套扩展点。
- 安全自查：每模块 Gate 抽查凭据不落明文（host secrets / safeStorage）、依赖许可清单（重点：PPT-Master 的 PyMuPDF AGPL 规避）、LGPL 合规三件套不变。
- i18n：所有新 UI 文案进 `packages/i18n` 8 语言目录，en 为源。
- 文档同步：模块 Gate 通过后在本 README 追加执行记录（沿用 `02-org-integration-plan.md` 的执行记录惯例）。
