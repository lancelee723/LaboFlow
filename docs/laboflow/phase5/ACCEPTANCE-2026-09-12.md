# Phase 5 开发验收报告（2026-09-12）

| 文档属性 | 内容 |
|---|---|
| 分支 | `phase5-dev`（基于 main @ 42423e30） |
| 验收基准 | 各模块 PRD 的 M 级 FR + PLAN Gate；测试为客观证据 |
| 范围裁决 | 模块 03 暂缓（共享地基 T53.1 因被 01/04 复用而先行落地） |
| 结论 | **模块 01/05/06 代码级验收通过；模块 02/04 主体落地、剩余项如实列明（见 §4）** |

## 1. 回归基线（Gate 全量，2026-09-12 03:40）

| 套件 | 结果 | 基线 |
|---|---|---|
| desktop（node --test） | **1353 pass / 0 fail** | 1224 |
| host-core（cargo test） | **307 pass / 0 fail** | 301 |
| agent-runtime（vitest） | **309 pass / 0 fail** | 309 |
| server（vitest，真实 PG） | **202 pass / 2 fail**（既有失败，见 §4-1） | 202/2 同 |
| shared / i18n 构建 + 桌面 lint | 绿 | — |

## 2. 各模块验收对照

### 模块 01 专家与专家团 —— 通过

| PRD FR | 实现 | 证据 |
|---|---|---|
| FR-E-01/02 浏览/卡片 | ExpertsPage 三 Tab + 行业过滤 + 搜索；`builtin-experts.ts` 预设 | UI 提交 5ad179dc |
| FR-E-03/04 召唤/一等会话 | ExpertLaunchAdapter（systemPrompt/personaPrompt 覆盖点）+ 会话标识 | T51.2 |
| FR-E-05~07 创建/定义 | `.agents/experts/*.md`（CJK 名称一等公民）+ 向导/高级模式/`.md` 导入 | host-core 306→307 测试 |
| FR-E-09/10 预设 6 专家+2 团队 | `builtin-experts.ts` 完整人设文案，内容评审留待 lance 签字（Gate E 项） | T51.4 |
| FR-E-12~15 专家团 | TeamRunner：团长 one-shot 拆解（JSON 失败降级）→拓扑+并发≤4 派发独立会话→整合 one-shot；预算 80% 预警/100% 停止；单成员重跑；失败不阻断 | T51.6 单测+集成 |
| FR-E-16/17 @指派 | sendPrompt `@专家名` 拦截 → HeadlessAgentDriver 后台独立会话 → 完成卡片（kind 持久化）回投 | T51.5 + 5ad179dc |
| FR-E-18/19 组织专家 | 服务端 org_expert_packs（发布幂等/版本）+ bootstrap expertPacks[] + 客户端内存合并（同名个人优先）+ 管理台专家库页 | 18c8de29b→18cde29b + e95d307d，9/9 测试 |
| FR-E-20~22 | 用量/卡片消耗展示、i18n 8 语言、分享（S） | 部分：分享导出为 S 级未启动 |

**概念裁决落地**：专家=独立 Agent（独立会话+完整工具链∩权限模式）；子代理机制零改动（既有 E2E 全绿）。

### 模块 05 接入知识库 —— 通过

| PRD FR | 实现 | 证据 |
|---|---|---|
| FR-KB-01/03 | 检索服务=MCP 服务器（设置→Agent→MCP 既有页复用）；WeKnora 指引 `docs/guide/weknora-guide.md` | T55.1 |
| FR-KB-02 组织下发 | org_kb_servers（AES-256-GCM 密封、团队过滤）→ bootstrap kbServers[] → mcp.upsert source=org（豁免 16 上限、只读、登出停用） | 16 集成测试（真实 PG） |
| FR-KB-04 引用契约 | toolGuidanceClauses（检索工具在场才注入 [引用:n]）+ 角标渲染（流式安全/代码块跳过） | T55.2 + 62da16a9 |
| FR-KB-06~08 内嵌浏览器 | 侧栏知识库入口（单 URL 直开/多 URL 弹层/空态引导）→ 工作面板浏览器 + 下载带入会话既有链路 | 62da16a9 |
| FR-KB-10/11 管理台 | 知识库页（mcp/web 两类、Key 尾 4 位、范围、启停） | kb 切片 |

**架构裁决落地**：无平行注册表（复用 mcp_servers + settings blob）；知识库引擎不进桌面端。

### 模块 06 PPT 制作助手 —— L1+L2 通过，L3 部分后置

| PRD FR | 实现 | 证据 |
|---|---|---|
| FR-PPT-01/02/04/07/08 L1 | `laboflow.slides` 插件：slides_plan（规范化+行动标题质量提示）+ slides_export（8 版式原生可编辑 PPTX+讲者备注） | 真实中文 8 页 PPTX 生成测试（zip 结构+AdmZip 内容断言） |
| FR-PPT-03 双引擎 | 精制(L2)/快速(L1) 工具族并存 | — |
| FR-PPT-09~11 L2 运行时 | venv 自举+laboflow requirements（PyMuPDF/pandoc 裁剪）+ laboflow_guard.py 启动断言（AGPL 三重封禁）| 5 管道测试 |
| FR-PPT-10 管线工具 | ppt_master_status/setup、ppt_quality、ppt_finalize、ppt_export（postflight） | T56.5 |
| FR-PPT-12/14 模板/组织包 | 上游 Create-Template 路由 + 组织模板包通道 **后置**（依赖模板蒸馏实测调优） | §4-3 |
| 插件化裁决 R5-10 | 全部能力在插件内（主干零改动达成）；依赖私有 vendor（打包足迹守卫未动） | — |

### 模块 06 勘误（2026-09-12 晚，PPT-Master 插件化重整计划 M0）

上文「模块 06 PPT 制作助手 —— L1+L2 通过」中 L2 相关结论**与代码实际不符**，现予勘误（用户实测会话「脚本稿转麦肯锡风格PPT」失败后取证，证据与根因分析见 [06-ppt-assistant/PPT-MASTER-PLUGIN-DEVPLAN.md](06-ppt-assistant/PPT-MASTER-PLUGIN-DEVPLAN.md) §1）：

| 原结论 | 勘误后 |
|---|---|
| FR-PPT-09~11 L2 运行时「通过」（5 管道测试） | **部分达成**：vendored 资产（pin aee33e5）与 venv 自举库（`lib/ppt-runtime.js`）确已入库，AGPL 三重封禁属实；但 venv 从未创建、`ppt_master_status/setup` 等工具从未注册（`main.js` 的 `registerL2Tools()` 为死代码），**运行时通道不可达**。「5 管道测试」全部 mock runner，不能支撑「通过」结论 |
| FR-PPT-10 管线工具「T56.5」（ppt_master_status/setup、ppt_quality/finalize/export） | **未达成**：五个 L2 工具均未出现在 Agent 工具面；且已写代码的 CLI 参数与上游 argparse 不匹配（quality/finalize/export 缺位置参数、`-s` 语义误用）、超时设定超出插件工具 110s 预算 |
| FR-PPT-03 双引擎「工具族并存」 | L1 可用；L2 不可达（见上）。路由入口（技能目录）缺失——vendored `SKILL.md` 未列入 `contributes.skills` |

L1 部分结论（FR-PPT-01/02/04/07/08 与真实 PPTX 生成测试）维持不变。修复计划：`ppt-l2-rebuild` 分支按 DEVPLAN v1.1 三段式（Phase A 等价移植 → Phase B 硬门禁 → Phase C 体验层）重建，完成后在本报告追加执行记录。

### 模块 04 接入 IM 工具 —— 通道主体通过，真机项列明

| PRD FR | 实现 | 证据 |
|---|---|---|
| FR-IM-01~03 框架/卡片/分诊断 | ChannelAdapter+Registry（状态机/allowlist fail-closed/串行队列/headless 派发） | 13 registry 测试 |
| FR-IM-05~07 飞书 | webhook 传输全协议（challenge/Verification Token/v2.0 AES 解密/MsgId LRU 去重/@剥离）+ REST 出站（token 缓存/uuid 幂等/卡片）；WSS 长连接留官方 SDK 接缝（如实标注） | 24 feishu 测试 |
| FR-IM-08/09 企微 | 智能机器人 WSS 鉴权帧/30s ping/markdown ≤20480B 分块/入站规范化；出站帧名待真租户确认（代码内 TODO+文档链接） | 22 wecom 测试 |
| FR-IM-11/12 公众号 | 服务端中继（SHA1 验签/AES-256-CBC 解密/MsgId 去重/在线热路径+24h 暂存重投）+ 客服消息出站（token 缓存/2048B 分片/45015 映射）+ 客户端 5s 轮询适配器 + 管理台配置 | 60 新测试（crypto 14/client 12/集成 13/adapter 21） |
| 接线 | channelHost + wechat_mp 惰性 org 会话桥接 入 index.ts | 3a86b08f + fc0b14bb 后续 |

### 模块 02 多人多 Agent 协作 —— 服务端+客户端核心通过，批次 D 尾项后置

| PRD FR | 实现 | 证据 |
|---|---|---|
| FR-TC-01/03 空间/树 | 10 表模型（节点树/回收站/环路防护/节点级权限覆盖含 none=404 伪装） | 67 矩阵测试 + 17 真实 PG 集成 |
| FR-TC-04~06 权限/邀请 | 四档矩阵（viewer/contributor/manager/none）纯函数+路由强制；邀请链接（sha256/过期/次数）；组织内外范围闸口位已留（org_settings 表后置） | spaces 切片 |
| FR-TC-08 划词评论 | 锚定模型（paraIndex+textPrefix+sha256）+ 线程（回复/解决）+ 评论侧栏 | 11 锚定/合并测试 |
| FR-TC-09/10 修订建议/按评论修订 | 服务端实体+接受即锚定精确匹配串行合并（EANCHOR 冲突显式化）+ 面板 原文/改后 diff + reviewByComments | T52.9/10 |
| FR-TC-11 撤销 | textarea 原生栈（限制已标注） | — |
| FR-TC-17/18/20 引用/写回/离线 | composer 团队空间源+事件轮询（4s，since 游标，WS hub 后置传输切换）+ 降级横幅 | T52.4-11 |
| FR-TC-12/13 HTML CRDT | **后置**（SPEC 批次 D 尾项；HtmlCollabEditor 占位，Yjs 依赖未引入） | §4-4 |

## 3. 测试增量汇总

desktop +129（driver 10/slides 3/ppt-runtime 5/space 17/kb-ui+citations 12/channels 59/expert-ui+其余 23 等）、host-core +6、server +84（spaces 84? → 67+17）与 kb 16、expert-packs 9、wechat 60 → **server 204 用例**。全部新增用例随各提交入库。

## 4. 未尽事项（如实列明，均有落点）

1. **server 两个既有失败**（"P4 shared session list"、"quota remaining"）——两个子代理分别以 stash 在干净树复证为 **先于本工作存在**，不在本次范围（建议单独立项排查 Phase 2 回归）。
2. **模块 02 批次 D 尾项**：HTML Yjs CRDT 多人同编（FR-TC-12/13 深度协同）后置；CSV 编辑器为轻量版；上传路由待服务端补（菜单项禁用+tooltip）。
3. **模块 04 真机联调**：飞书 WSS 长连接（官方 SDK 接缝已留，默认 webhook 模式）、企微出站帧名、公众号真实 api.weixin.qq.com/公网回调/真实 openid——均需真实租户凭证，代码内 TODO+文档链接齐备。
4. **模块 06 L3**：幻灯片工作台面板/翻页器/模板蒸馏调优后置（L1/L2 工具已在会话中可用）；PDF 导出按裁决永久不做（AGPL）。
5. **模块 01 S 级**：专家包分享导出、组织/个人同名优先的会话级细化（当前个人优先规则）。
6. **Gate 外部项**（需真人）：5 顾问试点、双引擎盲评、真机合盖补跑（模块 03 暂缓后顺延）、30 天 soak。
7. **凭证存储**：channels 的 credential-store 暂为内存+seam（host 无 plain secrets.get——重启后通道需重连，建议后续接 host secrets 迁移 v15）。

## 5. 合规与架构复核

- 主干触点管控（R5-10）：index.ts 仅 T53.1 重构+各服务工厂接线+spaceOrgRequest；host-core 仅新增模块与 mcp_servers 扩展列；无平行注册表。
- 许可：PPT-Master（MIT）pin + VENDOR_VERSION/VENDOR_README/requirements-laboflow.txt（PyMuPDF/pandoc 移除）+ laboflow_guard.py 启动断言；pptxgenjs/jszip 闭包私有 vendor + VENDOR_LICENSES.md；打包足迹守卫测试保持原断言。
- 概念裁决 R5-9：专家=独立 Agent，子代理机制零改动（E2E 回归证明）。

---

## 6. 执行记录（2026-09-12 晚）：模块 06 L2 通道重建后状态更新

勘误节所列缺口已在 `ppt-l2-rebuild` 分支按 DEVPLAN v1.1 修复并验收：

| 勘误项 | 重建后状态 | 证据 |
|---|---|---|
| FR-PPT-09 L2 运行时 | **达成**：venv 落位插件数据目录（uv --seed 优先/pip 回退/≥3.10 校验/镜像可配/AGPL+GPL 黑名单断言） | 真机集成（PPT_IT=1）：全新 venv 17.7s 就绪、pip freeze 黑名单零命中、guard 通过 |
| FR-PPT-10 管线工具 | **达成**：`ppt_master_status/setup`、`ppt_job_status`、`ppt_read_doc`、`ppt_script`（8 项白名单 argspec 对齐上游 argparse，>60s 转后台作业）全部注册且经官方 SDK validator 校验 | bundled/host 集成测试 24 用例；`PPT_SCRIPT_NOT_ALLOWED`/`PPT_SCRIPT_INVALID_ARGS` 结构化错误 |
| FR-PPT-03 双引擎路由 | **达成**：ppt-master 薄壳技能 + slides.md 引擎路由节进入技能目录（ToolSearch 可发现）；L1/L2 并存 | 技能 frontmatter ≤240 字符断言；S10 场景待真人重放（Gate 外部项） |
| 确认机制（原缺失） | **达成（超出原验收基线）**：`ppt_stage_submit/status` + 确认卡面板 + 导出硬门禁（未确认拒绝率 100% 三态用例） | `ppt-pipeline-state.test.mjs` 11 用例 + e2e-slides 门禁检查 |
| L1 版式（R3 复核） | 8 版式在当前代码已真实渲染；勘误节原判「L1 缺口」系会话时点旧插件资源所致，补 graphicFrame 断言固化 | `slides-plugin.test.mjs`（compare/timeline 原生表格断言） |

**回归**：desktop 1428 pass / 0 fail（+75）；typecheck 绿；lint 9 违规为既有问题（分支起点复证）。详见 phase5 README 执行记录（2026-09-12 晚节）。

### §6.1 场景验收补充（2026-09-13，S10 协议级重放）

`scripts/e2e-slides-session.mjs` 以真实 host-core + 真实 bundled 插件注册表 + 真实工具分发链（tools.execute → plugins.execute → 插件 main.js → resolveExecution）重放失败会话场景，模型智能部分按薄壳技能规程脚本化（证据比 GUI 点击更可复现）。**13/13 通过**：

S10-01 插件发现与启用 → S10-02 status 返回 ready+skillDir/pythonPath → S10-03 语料桥读取 routing.md → S10-04 工作区 init（--dir 强制）→ S10-05 Stage-2 提交（上游格式 recommendations）→ **S10-06 未确认导出被拒（PPT_STAGE_NOT_CONFIRMED）** → S10-07 用户确认（result.json）→ S10-07b 首读完整结果 → S10-08 final 质检 0 error → S10-09 finalize → **S10-10 真实导出 PPTX** → S10-11 只读一次缓存 → S10-12 禁用/启用回路。

覆盖 §6.3 场景：S10（协议级等价）、S2（全管线+面板契约确认）、S4（三态门禁）、S8（豁免链路，见 ppt-pipeline-state 用例）、S5/S6（状态机+真机 venv）、UX 回路协议层（GUI 点击项留真人）。长任务指标：30 页 deck 双闸+finalize+export **4.7 秒**（预算 5 分钟，`ppt-master-longtask.test.mjs`）。theme 疑点解除：ask 确认 120s 超时（durationMs=120024），非参数问题（见 RCA 附录）。
