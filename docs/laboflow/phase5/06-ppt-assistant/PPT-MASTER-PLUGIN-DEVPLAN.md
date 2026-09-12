# PPT-Master 插件化重整开发计划（模块 06 · L2 通道重建）

| 文档属性 | 内容 |
|---|---|
| 日期 | 2026-09-12 |
| 状态 | **已实施完毕（同日）**：M0 → Phase A/B/C → G 全部合入 `ppt-l2-rebuild` 分支并通过验收，执行记录见 phase5 `README.md`「执行记录（2026-09-12 晚）」与 `ACCEPTANCE-2026-09-12.md` §6。实施偏差：① `ppt_script` 白名单 8 项（project_manager 三子命令合并为一项，import-sources 增补）；② R3 经复核在当前代码不成立（会话时点旧资源所致），C.1 由「重写渲染」变为「graphicFrame 断言固化」；③ lint 9 个违规为既有问题（a7a2febd），不在本计划范围 |
| 修订 | v1.1（同日）：采纳「Claude Code 等价形态先行」三段式路线（M0 → Phase A/B/C → G 收尾），价值兑现点提前至第 2.5 周，新增裁决 RP-8；v1.0：M0–M5 六阶段初稿 |
| 范围 | `laboflow.slides` 插件 L2（PPT-Master）运行时通道重建：管线暴露、对话确认、依赖环境整合、工作台 UI；与 L1 补课 |
| 前置 | Phase 5 模块 06 已合入代码（T56.1–T56.6，commit a5117501 等）；本计划**取代** `PLAN.md` 中 T56.4–T56.6 的 L2 实施方式，并吸收 T56.7–T56.10（L3）中确认卡/翻页器/工作台三项进 Phase B/C |
| 输入 | ① 失败会话取证（`~/.pi-desktop/sessions/3bd626ab-42fc-4c6a-ada4-657b18df2a18.jsonl`，「脚本稿转麦肯锡风格PPT」）② PPT-Master 项目研读（本地 `/Users/lance/AI/Skills/ppt-master`，v6.3.2+41）③ Pi/Pi-Desktop 插件规范全站研读（pi-docs.aiuo.net，20 页）④ laboflow-v2 代码实勘 |
| 人力假设 | 1 名全栈工程师为主；设计兼职在 Phase C 介入（确认卡/工作台视觉）。总工期约 **7 周** |

---

## 0. TL;DR

用户实测「脚本稿转麦肯锡风格PPT」失败的直接原因不是 PPT-Master 不好用，而是 **LaboFlow 侧的 L2 通道从未打通**：vendored 资产（69MB，pin aee33e5）只是静态躺在插件目录里——L2 工具的注册函数是**死代码**（`main.js:287` 从未被调用）、上游 `SKILL.md` **不在 `contributes.skills`** 里对 Agent 不可见、已写好的 4 个 L2 工具 **CLI 参数与上游 argparse 全部不匹配**、Python venv **从未创建**（`~/.laboflow/ppt-runtime/` 不存在）。Agent 因此只能走 L1（仅标题+要点渲染），被迫逆向插件产物并手写 python-pptx 后处理，其间穿插 6 次权限拒绝与视觉校验环境缺失，最终被用户终止。

本计划采纳「**Claude Code 等价形态先行**」的移植路线（RP-8）：**Phase A**（2 周）把 PPT-Master 在 Claude Code 里的运行形态原样移植到 Pi 运行时——单技能语料 + Agent 直调脚本 + 上游自己的 chat 确认分支——只补两样 Claude Code 插件没有的东西：venv 化的依赖层（uv + AGPL 裁剪）和四个最小工具（status/setup/job/read_doc）；**Phase B**（1.5 周）针对已被失败会话证伪的「提示词级确认」补工具层硬门禁（`pipeline-state` 状态机 + 脚本白名单 + MVP 确认面板）；**Phase C**（2 周）上体验层（精制确认卡、工作台翻页预览、L1 版式补课）。全程维持「文件协议保真」：上游项目文件协议（`recommendations.stage*.json` / `result.json` / `design_spec.md` / `spec_lock.md` / `svg_output/`）零修改，上游升级只需 re-vendor + 薄壳 diff。价值兑现点在第 2.5 周（Phase A 出口即可用真·麦肯锡风格管线），每个后续阶段都是对已工作基线的增量增强。

---

## 1. 当前已开发的 PPT-Master 插件情况与目标能力缺失分析

### 1.1 现状地图

插件位于 `apps/desktop/resources/plugins/laboflow.slides/`（bundled，`enabledByDefault: true`，经 `electron/main/host-process.ts` 的 `resolveBuiltinPluginsDir` 三级回退加载，`build.extraResources` 随安装包分发）：

```
laboflow.slides/
├── manifest.json          # 仅声明 L1：2 agentTools + 1 skill + 2 settings
├── main.js                # onLoad 只注册 L1 两工具；L2_TOOLS 定义了但从未注册
├── lib/
│   ├── slides.js          # L1 纯 JS：normalizeOutline（8 版式）+ pptxgenjs 导出 ✅ 可用
│   └── ppt-runtime.js     # venv 自举/守卫/子进程封装（无 pi.*，可无头测试）✅ 库完整
├── skills/slides.md       # L1 工作流提示词（两段确认，纯提示词约束）
├── vendor/                # pptxgenjs 闭包（CJS 化 + 自带 jszip）
└── vendored/ppt-master/   # 上游 pin aee33e5（v6.3.2 post），69MB：
    ├── SKILL.md           #   上游技能入口（142 行路由规程）—— 未贡献给 Agent
    ├── workflows/         #   routing / generate-pptx（Step1-7）/ profiles / stages / governance
    ├── references/        #   44 个参考文档（strategist / executor / confirm-surface…）956KB
    ├── scripts/           #   261 个 .py + laboflow_guard.py（LaboFlow 新增）+ confirm_ui/
    ├── templates/         #   12,183 个 SVG（54MB，图标/图表/版式库）+ 四类模板工作区
    ├── requirements-laboflow.txt  # 裁剪版：9 包全 MIT/BSD/Apache，PyMuPDF/pandoc 已移除
    └── （含 106 个误提交的 .pyc，卫生问题）
```

L1 能力真实可用：`slides-plugin.test.mjs` 3 个用例（含真实中文 8 页 PPTX 解包断言）。测试规范：desktop 侧 `node --test apps/desktop/test/*.test.mjs`，另有 `ppt-master-runtime.test.mjs`（5 用例，**全部 mock runner**）与 `bundled-plugins.test.mjs`（对 pi.browser 等有结构断言，**对 laboflow.slides 零断言**）。

### 1.2 L2 四重断裂（代码证据）

| # | 断裂点 | 证据 | 后果 |
|---|---|---|---|
| 1 | **工具未注册** | `main.js:287` `registerL2Tools()` 全文件无调用点；`onLoad()`（main.js:39）只注册 L1 两工具 | `ppt_master_status/setup/quality/finalize/export` 从未出现在 Agent 工具面 |
| 2 | **技能不可见** | `manifest.json:68` `"skills": ["./skills/slides.md"]`；vendored `SKILL.md` 不在列 | Agent 系统提示的技能目录里没有 ppt-master 路由入口，无从得知管线存在 |
| 3 | **CLI 参数全错** | `ppt_quality` 传零参数（上游 `svg_quality_checker.py` 要求位置参数）；`ppt_finalize` 缺 `project_dir` / `project_path` 位置参数；`ppt_export`（main.js:236）缺 `project_path` 位置参数且 `-s` 误传绝对路径（上游语义为 project-relative source） | 即使注册，四个工具一调即 argparse 报错 |
| 4 | **超时预算违例** | main.js 中 quality/finalize/export 设 5/10/15 分钟超时，而 Pi 插件工具执行预算为 **110 秒**（ADR 0008：load 15s / 钩子 5s / command 30s / tool 110s） | 即使参数修对，长任务也会被宿主掐断 |

### 1.3 失败会话取证摘要（2026-09-12 09:17–10:00）

时间线：用户要求「使用 SLIDES 插件将脚本稿做成麦肯锡风格 PPT」（明确要求信息密度大、多图表、严格按稿分页）→ Agent `ToolSearch` 只搜了 `plugin_laboflow_slides_slides_plan/export` 两个 L1 工具名（**全对话 0 次提及 ppt_master**）→ `slides_plan` 返回「请向用户逐页确认」，Agent 以 thinking 判定「用户的详细要求即预确认」，跳过确认直接探针导出 → 发现 L1 导出器**只渲染 title/bullets**（data/matrix/columns/milestones 字段被忽略）→ 逆向导出物几何、手写 4 个 python-pptx 后处理脚本 → 期间 6 次 `TOOL_DENIED permission denied`（含一次带 theme 参数的 slides_export），唯一一次用户交互是 asktool 问「是否恢复命令行权限」（**从头到尾没有就大纲/设计征求确认**）→ 最终产出 3 页 PPTX 后卡在视觉校验（soffice 在但 pdftoppm/gs/pymupdf/pypdf 全缺）→ 用户在 `pip3 install pymupdf` 时手动终止。

四个根因（R1–R4）：

- **R1 触发断裂**：用户点名「SLIDES 插件」+ Agent 只按名搜索工具 + 技能目录无 L2 入口 → L2 存在但不可达。venv `~/.laboflow/ppt-runtime/` 从未创建（`ppt_master_setup` 无入口也无人调用）。
- **R2 确认失效**：`skills/slides.md:27`「用户未确认大纲前不得调用 slides_export」是提示词级约束，被系统提示的「端到端完成」倾向压过——插件没有任何工具级/文件级手段强制确认。
- **R3 能力天花板**：L1 导出器不渲染图表/矩阵/对比/时间线版式，迫使 Agent 走野路子（这也说明用户要的「麦肯锡风格」本质上就需要 L2）。
- **R4 环境与权限摩擦**：L2 依赖环境既装不上也查不了（status 工具未注册）；Agent 直接 Bash 跑 python 反复触发权限拒绝，浪费约 20 分钟。

### 1.4 目标能力缺失清单

| 严重度 | 缺失项 | 对应目标能力 |
|---|---|---|
| 致命 | L2 工具注册 + 参数适配（§1.2 #1/#3） | 管线可执行 |
| 致命 | 上游 SKILL/workflows/references 暴露为技能（§1.2 #2） | 管线可发现、可遵从 |
| 致命 | SPEC 规划的 `ppt_plan`（Strategist 编排）零实现 | 分阶段规划 |
| 严重 | 对话确认机制：上游 confirm-surface（两阶段确认）vendored 但零桥接 | 「不与用户交互」的直接病灶 |
| 严重 | Python 运行时引导：无 uv、无 ≥3.10 校验、镜像不可配、setup 无入口、超 110s 预算 | 依赖环境整合 |
| 严重 | L1 版式渲染缺口（chart/matrix/compare/timeline） | 快速引擎基本盘 |
| 中 | SPEC §3.5 四个 UI 组件（大纲确认卡/翻页器/工作台/导出卡）零实现（renderer 无任何 slides 代码） | UI 人性化 |
| 中 | 长任务异步作业模式（110s 预算内无法同步跑 setup/export） | 管线可靠性 |
| 中 | 引擎路由（L1/L2 选择，FR-PPT-03）、产物登记（FR-PPT-06）、成本预估（FR-PPT-16）未实现 | 体验完整性 |
| 低 | 106 个 `.pyc` 入库；69MB vendor 进 git 与安装包；VENDOR_README 引用不存在的测试文件 | 工程卫生 |
| 治理 | **ACCEPTANCE-2026-09-12.md §2 声称 FR-PPT-09/10/11「通过」与实际不符**（工具不可达、引导无入口；「5 管道测试」全 mock 无法支撑该结论） | 验收诚信，须勘误 |

---

## 2. PPT-Master 项目研读核心发现

> 源：`/Users/lance/AI/Skills/ppt-master`（remote hugohe3/ppt-master，checkout `v6.3.2-41-gcf1c2eb9`，MIT）。laboflow-v2 vendored pin 为 `aee33e5`（v6.3.2 post，2026-09-12）。

### 2.1 定位与总体架构

「AI generates native PowerPoint from any document」——不是可执行程序，而是**「提示词即工作流」**：一套 skill 提示词（路由/规划/执行三角色）+ 261 个 Python 确定性脚本，由宿主 agent（Claude Code 为首推）驱动，产出**原生可编辑** PPTX（真实形状/图表/表格/母版，非贴图）。数据不出本机。

三条顶层路线（`workflows/routing.md`）：**Generate PPTX**（Default / Quick / Beautify / Image-to-PPTX 四 profile）、**Create Template**（Brand/Style/Layout/Deck 四类蒸馏）、**Edit Native PPTX**（回写编辑，未改页 byte 级还原）。

### 2.2 Default 管线（Generate PPTX）

```
源(PDF/DOCX/XLSX/PPTX/URL/MD/主题)
 → Step1 source_to_md.py（→ sources/<stem>.md；主题/事实不足走 topic-research）
 → Step2 project_manager.py init（→ projects/<name>_<date>/，含 validation/workflow.log 审计）
 → Step3 模板候选准备（confirm_ui/template_options.json，无交互）
 → Step4 Strategist：
     ⛔ Stage-1 确认（沟通契约：受众/意图/结果/核心信息/交付场景… + 自由设计 vs 模板选择）
     → 模板安装（apply-template-workspace → design_spec.<kind>.<id>.md + template_handoff.json）
     ⛔ Stage-2 确认（3 个完整设计方向选 1、页数、图片来源、notes/动画/旁白、generation_mode、refine_spec）
     → 落盘 design_spec.md（I–X 十节：契约/画布/视觉主题/排版/布局/图标/可视化/图片清单/逐页 roster/讲稿）
     ⛔ Gate1（spec 逐字段审计）→ 可选 refine-spec 用户审稿
     → 落盘 spec_lock.md（执行锁：色/字锚点/icons/images/page_rhythm/pptx_structure）
     ⛔ Gate2（锁保真）+ project_manager.py validate
 → Step5 图片获取（条件：ai/web/slice 三路，17 个生图后端 + Openverse/Wikimedia 免 key 搜索）
 → Step6 Executor：text_measure.py calibrate → 逐页手写 svg_output/NN_*.svg
     → 早闸门（第 5 页后 svg_quality_checker --stage early）→ 剩余页 → 终闸门（--canonical-authoring --stage final，0 error 放行）
 → Step7 后处理（严格串行）：total_md_split.py → finalize_svg.py（→ svg_final/ 自包含预览）
     → svg_to_pptx.py（→ exports/*.pptx + validation/*.report.json POSTFLIGHT 回执 + backup/）
```

**核心设计三件套**（最值得继承）：

1. **确认回执协议**：`⛔ BLOCKING`（Stage-1/Stage-2/Gate1/Gate2，"wait for explicit user confirmation. Do not decide on the user's behalf"）与 `🚧 GATE`（前置条件检查）两级纪律话术；agent 写 `recommendations.stage{1,2}.json`（推荐）→ 用户经确认面提交 → 插件/宿主写 `result.json`（**只读一次**，此后禁止重开）；"Only the user confirms … silence confirms nothing"——明确禁止 agent 代确认。
2. **产物所有权模型**：`svg_output/` 是唯一可见设计源，`svg_final/`、`exports/`、`backup/` 全是派生物；阶段间状态完全靠项目目录文件传递（不依赖会话记忆），上下文失效时 Executor 重读 spec+lock 恢复，split 模式跨会话续跑（`stages/resume-execute.md`）。
3. **闸门化质检**：`svg_quality_checker.py` 的 JSON 报告与导出器**指纹绑定**（报告过期/缺失则 `svg_to_pptx.py` 拒绝执行），fail-closed。

确认面双通道：默认浏览器向导（`scripts/confirm_ui/server.py`，Flask，6060 起始端口，`--wait-only` 阻塞轮询 `result.json`）；用户明确要求时走 chat 确认（等价语义）。实时预览是另一个 Flask 服务（`svg_editor/server.py --live`）。

### 2.3 Claude Code 插件形态

| 项 | 内容 |
|---|---|
| 清单 | `.claude-plugin/marketplace.json`（marketplace：`git-subdir` 指向仓库 `skills/` 目录，version 6.3.2）+ `skills/.claude-plugin/plugin.json`，后者仅一个字段 `"skills": "./"`——**整个 skills 目录即插件，唯一 skill 就是 ppt-master 本体** |
| 组成 | **无 commands、无 agents、无 hooks**；Strategist/Executor 是提示词内伪角色（「Role Switch」仪式切换），唯一例外：visual-review 阶段并行派发匿名 subagent 批量看图 |
| 安装 | `/plugin marketplace add hugohe3/ppt-master` + `/plugin install ppt-master@ppt-master`（或跨 agent 的 `npx skills add`）；**装完仍需手动 `pip install -r requirements.txt`**（官方描述里显式提示） |
| 脚本调用 | agent 用 Bash 直调 `python3 "${SKILL_DIR}/scripts/xxx.py"`，每命令独立调用、禁止 cd/批量循环 |
| 环境自检 | **无统一预检脚本**：Python ≥3.10 只写在文档；采用 fail-closed 逐包提示（如 `import fitz` 失败即打印安装指引退出）；另有 `attribution_guard.py` 完整性闸（SKILL frontmatter/LICENSE SHA256/9 个关键脚本的 AST 级校验，SKILL.md 加载第 2 步强制先跑，非零即停） |
| 确认机制 | 无命令分阶段——靠流程文件内 ⛔ BLOCKING 话术 + Flask 确认页（命令阻塞等待回执文件落盘）；「快速生成」话术显式绕过全部确认 |

**移植可行性判定**（对照 Pi 运行时，Phase A 的依据）：

| Claude Code 组成 | 判定 | 说明 |
|---|---|---|
| 技能语料（单 skill + 引用文档链） | ✅ 直接可移植 | Pi `contributes.skills` 注册薄壳（描述压至 ≤240 字符）；正文 ≤128KiB 满足；引用文档经 `ppt_read_doc` 按需读取 |
| 脚本直调（Bash，`${SKILL_DIR}`） | ⚠️ 需适配 | Pi 不注入 SKILL_DIR、Read 沙箱不达 app resources、解释器须为动态 venv 路径 → `ppt_master_status` 返回 `{skillDir, pythonPath}`，薄壳 preamble 规定先取再调 |
| pip 依赖 | ❌ 上游不解决 | 官方明示装完手动 pip install；且上游 requirements 含 PyMuPDF（AGPL）/edge-tts（GPL）/ebooklib（AGPL）→ venv+uv+裁剪集+守卫必须自建（Phase A） |
| Flask 确认向导 | ❌ 不可行 | 裁剪集无 flask 是小事；致命的是 `--wait-only` 阻塞等待撞 Pi 工具超时预算（tool 110s/宿主 120s），用户填表两分钟即被掐断；内嵌浏览器打开也救不了超时 |
| chat 确认分支 | ⚠️ 可移植、非终态 | 上游 confirm-surface.md 自己定义的等价通道，话术可原样生效；但失败会话 R2 已证伪其可靠性 → Phase A 采用、Phase B 加硬门禁 |
| commands/agents/hooks | — | 上游没有，无需移植 |

### 2.4 依赖与许可（LaboFlow 视角）

上游 `requirements.txt` 19 包，LaboFlow 裁剪版 `requirements-laboflow.txt` 保留 9 包（python-pptx / XlsxWriter / skia-pathops / uharfbuzz / PyYAML / mammoth / markdownify / openpyxl / requests / beautifulsoup4，全部 MIT/BSD/Apache）：

| 风险依赖 | 上游用途 | LaboFlow 处置 | 可替代性 |
|---|---|---|---|
| **PyMuPDF**（AGPL-3.0） | 仅 `source_to_md/pdf_to_md.py` 的 PDF→MD（不做渲染/不产 PDF） | 已移除 + `laboflow_guard.py` import 探测 + `PPT_MASTER_DISABLE_PDF=1` 三重封禁 ✅ | 高：PDF 源路线整体禁用，用户先转 docx/md 即可 |
| **edge-tts**（GPL-3.0） | 旁白 TTS（`notes_to_audio.py`） | 不在裁剪集 ✅（须补注释与断言，防回归） | 高：后续可接云端 TTS（上游本就支持 ElevenLabs/MiniMax/Qwen） |
| **ebooklib**（AGPL-3.0） | 仅 .epub 输入 | 不在裁剪集 ✅（同上） | 高：v1 不支持 epub 源 |
| flask / Pillow / numpy | confirm_ui、svg_editor、图片后处理 | 不在裁剪集 → vendored Flask 确认页/实时预览在本 venv 跑不起来 | 由 LaboFlow chat 确认（A）/MVP 面板（B）/精制确认卡+工作台（C）替代 |

外部二进制：Pandoc 仅小众格式 fallback（已裁）；Playwright+Chromium 仅 opt-in 视觉自检（不用）；ffmpeg 仅直出 MP4（不用）；**无 LibreOffice 依赖**。字体不内置（锁定目标机器已装字体名）。图标库 12,027 SVG（Tabler MIT / Phosphor MIT / CHUNK CC-BY-4.0 / Simple Icons CC0）。

### 2.5 生成机制

AI 手写「项目规范 SVG」→ 自研编译器 `svg_to_pptx.py`（drawingml 映射 + native chart/table/formula OOXML + python-pptx 装配骨架 + 读回校验）→ 原生 DrawingML。结构双模式（flat 自由设计 / structured 真母版继承）；`--native-charts-and-tables` 输出带 Edit Data 的原生图表；公式编译为可编辑 OMML。模板四类正交（Brand=身份 / Style=方法论如 mbb-consulting 麦肯锡风格 / Layout=母版版式 / Deck=整合），**「麦肯锡风格」是提示词规范（answer-first、编号 exhibit、key-message 列）而非 PPTX 模板文件**——这正是用户诉求「麦肯锡风格」的正规实现路径。

---

## 3. Pi / Pi-Desktop 插件开发文档核心发现

> 源：pi-docs.aiuo.net（主教程 + `/spec/07-plugins/` 01–16 全部子页 + 3 个根站概念页）。以下只列对本插件有直接约束/机会的结论。

### 3.1 插件基本架构

- **形态**：`manifest.json`（schemaVersion=1）+ `main.js`（CommonJS/ESM，`module.exports = { onLoad, onUnload }`，宿主注入全局 `pi`；仅这两个钩子已实现）+ 可选 `renderer/`（面板）、`skills/`、`preload.js`。分发物必须是可直接执行的 JS/HTML/CSS——**宿主不装依赖、不编译 TS**。
- **三层隔离**：Host Main（PluginManager + PermissionGateway）→ 每插件独立 utilityProcess（JSON RPC 到 broker）→ 沙箱面板（独立 BrowserWindow + session partition，无 Node，只有 `window.pluginBridge.invoke(channel, payload)` 白名单通道）。
- **时间预算（ADR 0008，本计划的关键约束）**：load 15s / 生命周期钩子 5s（退出 1.5s）/ command 30s / **agent tool 110s**（宿主管线 120s 内）。
- **服务**：`pi.services.register({id, start, stop})`，每插件 ≤4 个，start 幂等，崩溃退避重启 1→2→4→8→16→30s 封顶、5 次后 failed，存活 60s 归零。

### 3.2 能力面（contributes）关键限制

| 贡献类型 | 关键 schema/限制 | 本插件用法 |
|---|---|---|
| `agentTools` | `{name, description, risk(low/medium/high), schema, timeoutMs?}`；模型可见名强制 `plugin_<pluginIdSafe>_<toolName>`；**工具默认不进系统提示，进有界 On-demand 目录，经 ToolSearch 激活（每次 ≤4 个）——一行描述即可发现性**；风险缺失/非法默认 medium | L2 工具面收敛在 7 个，描述中英关键词覆盖 |
| `skills` | frontmatter 必须含 `name`+`description`；**每插件 ≤32 个、每文件 ≤128 KiB、description ≤240 字符**；目录进系统提示、正文经内置 Skill 工具按需加载 | 2 个技能（ppt-master 薄壳 + slides-l1 路由增强）；语料经 `ppt_read_doc` 按需读 |
| `views` | `{id, title, icon(宿主 token), entry, order}` + `ui.view` 权限；同一 HTML 可复用于面板与 docked 视图（docked 时 titlebar-height=0） | PPT 工作台（Phase C） |
| `ui.panel` | 浮窗，46px 拖拽带用 `var(--pi-plugin-titlebar-height, 46px)` | 确认面板（Phase B MVP → Phase C 精制） |
| `commands` | `{id, title, keywords}` → 全局搜索/命令面板 `plugin.<id>.<command>`，**用户显式触发**（Agent 不可调） | 「打开确认卡」入口（Phase B） |
| `settings` | `{key, title, type(string/number/boolean/select/json/shortcut), default}`；**不可存密钥**（`secret:true` 校验直接拒绝，D018） | pipMirror 等（Phase A） |
| `services` / `bus` | 见 §3.1；bus 主题声明式、收不到自己发的消息 | 作业监督/事件 |

### 3.3 安全边界

- **29 项权限、声明 ∩ 授予**；fs（root=workspace|userSelected + scope glob，缺省即每次问用户）与 net.domains 双 fail-closed；每次 broker 调用审计。
- **Plan 模式拒绝一切插件工具**（host-core 强制，不可绕过，伪造调用返回 `PLUGIN_DISABLED_IN_PLAN`）→ 技能必须检测并提示用户切换模式。
- **密钥不可及**：插件拿不到 provider key / 宿主 secrets / pi.sqlite / 其他插件数据；`agent.complete` 由宿主导管凭证。**子代理（delegate）不可分配插件工具、Skill、ToolSearch**——「派生子代理做 PPT」在 Pi 运行时里不可行（失败会话里 Agent 自己也发现了这一点）。
- **诚实声明**：插件主进程当前跑裸 Node 内建（broker 权限网关不约束直接 Node 访问）——bundled 一方插件受信没问题，但这意味着 `net` 白名单不约束插件子进程（python）的网络。记录在案即可。

### 3.4 存储、调试、分发与测试

- 存储：`pi.plugin.getDataPath()` → `~/.pi-desktop/plugins/data/<plugin-id>/`（laboflow-v2 的宿主数据根实测就是 `~/.pi-desktop/`：`pi.sqlite`、`sessions/`、`scratch/`）；设置存宿主 kv（`plugin:<id>` 命名空间）。
- 调试：dev 插件热重载（300ms 防抖，权限只降不升）；日志 Settings → Info → Logs 按 pluginId 过滤。
- 分发：`.piplug` = store-only ZIP、**≤50 MiB / ≤2000 文件**（69MB vendored 走不通）；bundled 插件经 `extraResources` 分发不受此限。`pi-plugin check`（与安装器同一套校验）/ `pack` / `publish`。
- **测试：官方设施只有 `@pi-desktop/plugin-sdk` 的 mock host 测试辅助**；无测试目录约定。实操回路=check → 干净状态实装 → 禁用/启用/卸载验证贡献消失 → 日志检查。

---

## 4. 将 PPT-Master 开发为 LaboFlow 插件的思路

### 4.1 设计原则（五条）

1. **Claude Code 等价形态先行（RP-8）**：先原样移植上游「单技能 + Agent 直调脚本 + chat 确认」的运行形态（只补依赖层与最小工具面），再分阶段加硬门禁与体验层。保真度最高、见效最快，上游升级只需 re-vendor + 薄壳 diff。
2. **文件协议保真**：上游项目文件协议（`recommendations.stage*.json`、`result.json`、`template_selection.json`、`design_spec.md`、`spec_lock.md`、`svg_output/`→`svg_final/`→`exports/` 所有权链、质检报告指纹）**零修改**。
3. **确认面替换、确认协议不动**：Flask 确认页（裁剪集里本就无 flask，且阻塞等待撞 110s 预算）→ chat 分支（Phase A，上游自有等价通道）→ MVP 面板（Phase B）→ 精制确认卡（Phase C）。回执始终是 `result.json`，**写入权只在用户侧**，Agent 只读一次。
4. **工具层强制，不再指望提示词自觉**：失败会话证明提示词级「不得导出」约束会被系统提示压过。Phase B 起确认状态落为 `pipeline-state.json`，导出类脚本执行前由插件硬校验 Stage-2 已确认。
5. **零主干改动（R5-10）**：全部能力经 `contributes`（agentTools/skills/views/settings/commands）承载，不碰 host-core/plugin-runtime；主干触点清单为空。

### 4.2 总体架构（三层，标注阶段归属）

```
┌─ 技能层（contributes.skills）──────────────────────────────────┐
│ [A] ppt-master：薄壳 preamble（Pi 约定：先调 status 取                       │
│     {skillDir, pythonPath}；语料经 ppt_read_doc 读；脚本用 venv 解释器       │
│     Bash 直调；Plan 模式提示；chat 确认纪律）+ 上游 SKILL.md 正文原样         │
│ [A] slides-l1（L1 工作流 + 引擎路由互链，修复 R1）                            │
│     其余语料（workflows/references/templates 文档）经 ppt_read_doc 按需读     │
├─ 工具层（contributes.agentTools：2 L1 + 7 L2）──────────────────┤
│ [A] ppt_master_status / ppt_master_setup(异步) / ppt_job_status /           │
│     ppt_read_doc（语料只读通道，白名单+防穿越）                                │
│ [B] ppt_script（9 项脚本白名单，参数对齐上游 argparse，>60s 转作业）/          │
│     ppt_stage_submit / ppt_stage_status                                      │
├─ 运行时与 UI 层 ────────────────────────────────────────────────┤
│ [A] venv@getDataPath/ppt-runtime（uv 优先）+ 作业管理器（进程内后台执行）      │
│ [A] chat 确认（上游 chat 分支话术）                                           │
│ [B] pipeline-state.json 状态机 + MVP 确认面板（ui.panel）+ 导出硬门禁         │
│ [C] 精制确认卡 + 工作台视图（contributes.views：状态卡/进度/翻页预览/导出卡）  │
│     + 原生通知链 + L1 版式补课                                                │
└─────────────────────────────────────────────────────────────────┘
```

工具面终态 9 个（L1 两个沿用）：Phase A 交付 4 个 L2 + 薄壳技能；Phase B 增补 3 个。每插件 ≤32 技能、正文 ≤128KiB 均满足。

### 4.3 管线转化映射表（`[A/B/C]` = 交付阶段）

| PPT-Master 步骤 | 上游机制 | LaboFlow 承载 | 确认语义 |
|---|---|---|---|
| attribution_guard 首步 | Agent 跑 python 校验 | [A] Agent 经 Bash 用 venv 解释器直调（薄壳 preamble 规定路径来源），失败 fail-closed | — |
| 路由 | SKILL.md 路由表 | [A] ppt-master 薄壳技能（上游路由表原样）+ slides-l1 互链（引擎选择：快速可编辑→L1；精品/品牌/麦肯锡→L2；显式快速→quick profile） | — |
| Step1 源转换 | `source_to_md.py` | [A] Agent Bash 直调（docx/xlsx/pptx/url/md；**pdf 由 preamble+环境变量双重禁用**，报错引导先转 docx/md）→ [B] 收进 `ppt_script` 白名单并给友好拒绝文案 | — |
| Step2 建项目 | `project_manager.py init` | [A] Agent Bash 直调，产物落工作区 `projects/<slug>_<yyyymmdd>/` → [B] `ppt_script("project_manager_init")` | — |
| Step3+4a Stage-1 | strategist 提示词 + confirm_ui | [A] strategist 语料经 `ppt_read_doc` 读；Agent 写 `recommendations.stage1.json`（上游格式）后在 **chat 中呈现沟通契约+模板候选并停下等待**（上游 chat 分支话术：「silence confirms nothing」）→ [B] `ppt_stage_submit("stage1")` + MVP 面板提交 + state=confirmed → [C] 精制三方向卡片 | **⛔ [B] 起硬门禁** |
| Step4b Stage-2 | 三方向选择 | 同上（stage2） | **⛔ [B] 起硬门禁** |
| Step4c 规划落盘 | Agent 写 design_spec/spec_lock | Agent 用自身 Write 写（工作区内）+ [A] Bash 直调 `project_manager.py validate` → [B] `ppt_script("project_manager_validate")`；Gate1/Gate2 随 Stage 状态机登记（轻确认） | ⛔ 轻确认 |
| Step5 图片获取 | image_gen/search/slice | v1：**占位符策略**（用户原诉求即接受占位）+ [A] Bash 直调 `image_search.py`（Openverse/Wikimedia 免 key，requests 已在依赖）→ [B] `ppt_script("image_search")`；AI 生图**后置**（settings 不能存密钥，待组织渠道下发 key 方案） | 🚧 |
| Step6 Executor | Agent 手写 SVG + text_measure + svg_editor live | Agent 用 Write 写 `svg_output/*.svg`；[A] text_measure/quality_checker 经 Bash 直调；实时预览=[C] 工作台视图直接渲染 SVG（Chromium 原生渲染，无需 Flask） | 🚧 早闸门 |
| Step7 后处理导出 | 三脚本严格串行 | [A] finalize/total_md_split/svg_to_pptx 经 Bash 直调（上游导出器自带质检报告指纹校验，fail-closed）→ [B] 全部收进 `ppt_script` 并叠加**Stage-2 确认硬校验**；预计 >60s 自动转异步作业（jobId + `ppt_job_status` 轮询） | — |
| POSTFLIGHT | report.json | 工具/命令回执摘要 + [C] 工作台导出卡（打开目录/重命名） | — |
| split 跨会话续跑 | 新会话 "继续生成 projects/<name>" | [A] 上游语义天然适配（Pi 子代理不可用插件工具，L2 必须主会话执行）；薄壳技能识别 resume 意图 → 重读项目文件恢复进度 | — |
| 旁白/动画/epub | edge-tts/ebooklib 等 | v1 不支持（RP-6，GPL/AGPL 排除）；文档明示降级 | — |

### 4.4 确认机制设计与三阶段演进

**终态（Phase C 后）流转**——`projects/<name>/laboflow/pipeline-state.json`：

```json
{
  "version": 1,
  "project": "maoming_chantou_20260912",
  "stages": {
    "stage1":     { "status": "pending|submitted|confirmed|waived", "submittedAt": "…", "confirmedAt": "…", "surface": "chat|panel" },
    "stage2":     { "status": "…", "waiveReason": "quick-mode" },
    "spec_gate1": { "status": "…" }, "spec_gate2": { "status": "…" }
  }
}
```

1. Agent 调 `ppt_stage_submit(stage, recommendations)` → 插件校验 schema → 写 `confirm_ui/recommendations.stage{N}.json`（**上游格式原样**）→ state=submitted → `pi.ui.openPanel()`（确认面板）+ toast。
2. 用户在面板上查看契约/三方向 → 提交（或点「快速模式」豁免，waiveReason 必填）；命令面板 `plugin.laboflow.slides.openConfirmCard` 是等价入口（**命令只负责打开面板，不直接确认**）。
3. 插件写 `result.json` + `template_selection.json`（上游字段原样）+ state=confirmed。
4. Agent 调 `ppt_stage_status` 读结果（**只读一次**语义由插件保证：读过即标记，重复读返回缓存摘要并警告）。
5. **硬门禁**：`ppt_script` 对 `finalize_svg/total_md_split/svg_to_pptx` 前置校验 `stages.stage2.status ∈ {confirmed, waived}` 且 `spec_lock.md` 存在；不满足返回 `{code: "PPT_STAGE_NOT_CONFIRMED", hint}`。

**三阶段演进**：

| 阶段 | 确认面 | 强制性 | 已知缺口 |
|---|---|---|---|
| **Phase A** | chat 分支（上游话术原样：Agent 呈现 recommendations 后停下等用户显式回复） | 提示词级 | R2 风险仍在（验收口径明确写「chat 级确认」，**Phase B 合入前不向组织推广**） |
| **Phase B** | MVP 面板（功能完成为主：契约摘要 + 方向单选 + 确认/快速按钮，zh/en 双语）+ 状态机 + 导出硬门禁 | 工具级 | 视觉未打磨 |
| **Phase C** | 精制确认卡（设计兼职出图，三方向卡片含色板/字体预览，8 语言）+ 原生通知引导 | 工具级 + 体验完整 | — |

**降级路径**：用户显式「快速生成/不用确认」→ 面板「快速模式」豁免（waiveReason 必填落盘）——quick 也不能由 Agent 单方面 waive，符合上游「silence confirms nothing」。

### 4.5 依赖环境整合（Phase A 交付）

| 项 | 设计 |
|---|---|
| venv 落位 | `pi.plugin.getDataPath()/ppt-runtime/venv`（规范路径，卸载即随数据清理）；兼容探测旧 `~/.laboflow/ppt-runtime` 并首启迁移 |
| 解释器 | 探测顺序：`uv`（`uv venv` + `uv pip install -r`，目标 ≤3 分钟）→ 系统 `python3`（**解析版本号，≥3.10 且 <4.0**，修复现状只探测命令存在的问题）→ 全缺则给出平台安装指引 |
| 镜像 | manifest settings 新增 `pipMirror`（select：默认/清华/阿里/自定义 URL），注入 `PIP_INDEX_URL`/`UV_INDEX_URL`（修复现状：参数存在但调用处不传、设置项缺失） |
| 安装 | `ppt_master_setup` 异步作业（9 包 wheel 下载可能 >110s）：立即返回 jobId，进度经 `ppt_job_status` 查询，日志进插件日志可过滤 |
| 自检 | `ppt_master_status` 五态（missing-python/venv-missing/guard-failed[:agpl]/deps-missing/ready）+ **附带 `{skillDir, pythonPath}`**（Phase A 薄壳技能的路径来源）+ doctor 动作建议；[C] 工作台常驻「运行时状态卡」 |
| 红线维持 | 裁剪集 9 包不变；`laboflow_guard.py` + `PPT_MASTER_DISABLE_PDF=1` + 测试断言「上游 requirements.txt 永不安装」三重封禁保持；**新增**：pip freeze 黑名单断言扩展 `edge-tts/ebooklib/flask`，requirements-laboflow.txt 注释补记排除原因 |
| 离线包（后置项） | 可选 wheelhouse 下载包（约 60–90MB，skia-pathops/uharfbuzz 二进制为主），settings 提供本地路径；不随安装包分发，避免体积膨胀 |

### 4.6 引擎路由与 L1 补课

- **路由（Phase A）**：由 ppt-master 薄壳技能自身承担（上游路由表原样：Default/Quick/Beautify/Create Template/Edit Native + 引擎选择「快速可编辑→L1」）；`skills/slides.md` 增「何时升级 L2」一节并互链——修复 R1（用户点名 SLIDES 插件时 Agent 仍能路由到 L2）。薄壳描述（≤240 字符）覆盖触发词：PPT/幻灯片/presentation/麦肯锡/McKinsey/咨询风格/精品/快速。
- **L1 补课（Phase C，修复 R3）**：`lib/slides.js` 导出器用 pptxgenjs 原生 `addChart/addTable` 渲染 `data/matrix/compare/timeline` 版式（不再归一为 bullets），schema 中这些字段从「接受但忽略」变为「真实渲染」。

### 4.7 UI 人性化（Phase B MVP → Phase C 完整）

- **确认面板（ui.panel 浮窗）**：Phase B 出 MVP（契约表单只读呈现 + 模板候选单选；Stage-2 方向单选 + 页数 + 开关组 + 「确认」/「快速模式」主次按钮，zh/en）；Phase C 设计兼职精制（三方向卡片含色板/字体/构图预览）。46px 拖拽带规范。
- **工作台（contributes.views，docked 面板标签，参照 pi.browser 先例，Phase C）**：① 运行时状态卡（五态 + 一键 setup）；② 管线进度时间线（读 pipeline-state.json）；③ **SVG 翻页预览**（直接渲染 svg_output/svg_final，缩放/页码/占位图提示）——替代上游 Flask live preview 的核心价值；④ 导出卡（产物列表/打开目录）。同一 HTML 复用浮窗形态。
- **通知（Phase C 完整链）**：submit → 原生通知 + toast；导出完成 → 通知。Phase B 先用 toast。
- **i18n**：B 阶段 zh-CN/en 双语；C 阶段补齐其余 6 语言（随仓库 `packages/i18n` 惯例，en 为源），经 `pi.app.getLocale()` 切换。
- **权限申明终版**：`["agent.tool.register", "agent.prompt.inject", "ui.panel", "ui.view", "notify", "fs.read", "fs.write"]`，fs scope 限定 `projects/**` 与 `slides/**`（A 阶段先只需前三+fs.write）。

### 4.8 裁决提案（RP 系列，供 README §4 裁决表增补）

| # | 裁决 | 理由 |
|---|---|---|
| RP-1 | L2 重整采用「文件协议保真 + 确认面替换」：上游项目文件协议零修改，Flask 确认页/实时预览替换为 LaboFlow chat 确认（A）/原生面板（B/C）与工作台 | venv 裁剪集本就无 flask；阻塞等待撞 110s 工具预算；协议保真使 re-vendor 成本最小 |
| RP-2 | 确认强制性最终由工具层状态机保证（Phase B 起，导出硬校验），提示词仅作引导 | 失败会话 R2 实证提示词约束不可靠 |
| RP-3 | venv 迁至插件数据目录（getDataPath），uv 优先 + 版本校验 + 镜像可配 + setup 异步作业化 | 对齐 Pi 存储隔离规范与 110s 工具预算 |
| RP-4 | Phase B 起确定性脚本一律经 `ppt_script` 白名单执行（参数 schema 对齐上游 argparse）；Phase A 允许 Agent Bash 直调（Claude Code 等价形态） | A 阶段保真优先；B 阶段参数契约单一来源、可审计、规避权限拒绝摩擦（R4） |
| RP-5 | L2 管线在主会话执行；跨阶段续跑映射上游 split 模式（新会话 + resume 路由）；不尝试子代理 | Pi 运行时硬限制：delegate 不可用插件工具 |
| RP-6 | edge-tts/ebooklib 明确排除（GPL/AGPL），旁白与 epub 输入 v1 降级不支持；PDF 源继续禁用 | 许可红线补全（此前只处理了 PyMuPDF/pandoc） |
| RP-7 | L1 同步补课：pptxgenjs 原生 chart/table 渲染四种版式（Phase C） | 失败会话 R3；L1 是永久保底引擎不是过渡品 |
| RP-8 | **移植路线 = Claude Code 等价形态先行**：Phase A 原样恢复上游「单技能 + Bash 直调 + chat 确认」运行形态（仅补 venv 依赖层与 status/setup/job/read_doc 四个最小工具）；Phase B 加工具硬门禁与脚本白名单；Phase C 加体验层。Phase A 的两阶段确认为 chat 级——**组织推广在 Phase B 合入后解锁** | 保真度最高、价值最快（第 2.5 周）；R2 教训由 B 阶段硬门禁修补；上游升级仅需 re-vendor + 薄壳 diff |

---

## 5. 落地实施步骤（M0 → Phase A/B/C → G，总 7 周）

> 串行为主（1 全栈工程师）；设计兼职在 Phase C 介入。每阶段含核心参数与量化退出指标；全部改动收敛在插件目录 + `apps/desktop/test/` + `scripts/` + 文档，**主干触点清单为空**（R5-10）。价值兑现点：**Phase A 出口（第 2.5 周）即可真实使用 L2 管线**（chat 级确认，beta）。

### M0 治理与基线（0.5 周）

**任务**
1. 验收勘误：`ACCEPTANCE-2026-09-12.md` §2 模块 06 表中 FR-PPT-09/10/11 状态改为「部分达成：资产已 vendor、运行时通道未打通」，附本计划 §1 证据索引。
2. 测试基线（先红后绿）：`bundled-plugins.test.mjs` 新增 laboflow.slides 断言组——manifest agentTools 含 L2 名单、skills 含 ppt-master 薄壳、vendored 关键文件（SKILL.md/workflows/generate-pptx.md/requirements-laboflow.txt）存在、**树内无 .pyc**。
3. 卫生：`git rm` 106 个 `.pyc`，`.gitignore` 加 `__pycache__/`；修正 VENDOR_README 引用的测试文件名。
4. R1–R4 转登记：失败会话四根因录入 issue（作为 Phase A/B/C 的验收锚点）；记录 `slides_export` 带 theme 参数被拒一次的复现探针（会话 09:48 现象，属权限引擎疑点，单独排查）。

**核心参数**：无代码行为变更；断言清单见上。
**退出指标**：desktop 测试新增 ≥6 条断言；仓库 0 `.pyc`；勘误合入。

### Phase A：Claude Code 等价形态移植（2 周）—— 价值兑现点

**任务**
1. **运行时层**（原 M1 全部）：`lib/ppt-runtime.js` venv 根迁 `getDataPath()`（含旧路径探测迁移）；`ensureRuntime` 支持 uv 路径（`uv venv` + `uv pip install -r`，镜像 env 双注入 `PIP_INDEX_URL`/`UV_INDEX_URL`）、python 版本号解析校验（≥3.10 <4.0）；manifest settings 增 `pipMirror`。
2. **作业管理器**：插件进程内后台作业（create/cancel/poll/persist：job 记录落 `getDataPath()/jobs/`，插件重载后标 interrupted）；`ppt_master_setup` 异步化（返回 `{jobId}`）；新增 `ppt_job_status`。
3. **最小工具面注册（4 个）**：`ppt_master_status`（五态 + **返回 `{skillDir, pythonPath}`**）、`ppt_master_setup`、`ppt_job_status`、`ppt_read_doc`（语料只读通道：白名单 `vendored/ppt-master/{SKILL.md, workflows/**, references/**, templates/*.md, scripts/docs/**}`，路径规范化防穿越，单次返回 ≤1MiB，目录路径返回清单）。manifest 同步声明；**删除** main.js 中 `ppt_quality/ppt_finalize/ppt_export` 死代码与错误参数定义（Phase B 由 `ppt_script` 以正确契约重建）。
4. **薄壳技能**：`skills/ppt-master.md` = LaboFlow preamble（① 硬性第一步调 `ppt_master_status` 取 `{skillDir, pythonPath}`，禁止猜路径（对齐上游 "never search or guess"）；② 语料文档一律经 `ppt_read_doc` 读取；③ 脚本一律 `Bash: ${pythonPath} ${skillDir}/scripts/…` 每命令一次；④ chat 确认纪律原样（⛔ BLOCKING/silence confirms nothing）；⑤ Plan 模式与权限模式提示——建议用户在 accept-edits/auto 下运行 L2 会话，缓解 R4 摩擦；⑥ resume 路由）+ 上游 SKILL.md 正文原样（142 行，总量远小于 128KiB）；frontmatter description ≤240 字符、覆盖触发词。`skills/slides.md` 增「何时升级 L2」路由节。
5. **S10 重放验收**（见 §6.3）。

**核心参数**：venv 路径 `getDataPath()/ppt-runtime/venv`；uv 探测 5s 超时；setup 作业超时上限 15 分钟（后台不受 110s 限制）；job 记录保留最近 20 条；`ppt_read_doc` 白名单根固定 vendored/ppt-master、拒绝 `..` 与符号链接。
**退出指标**：
- ① 单测：bootstrap 决策矩阵（uv 有/无 × python 版本合格/不合格 × 旧 venv 存在/不存在 ≥8 用例，mock runner）+ `ppt_read_doc` 白名单与穿越防护 ≥4 用例；
- ② 真机集成（`PPT_IT=1` 门控）：全新 venv → setup 作业 → `ready`，镜像 ≤5 分钟 / 直连 ≤8 分钟；`pip freeze` 黑名单（fitz/PyMuPDF/pandoc/edge-tts/ebooklib/flask）零命中 + guard 通过；
- ③ bundled 断言（M0）转绿；技能结构断言（frontmatter/名称/描述 ≤240/文件 ≤128KiB）；
- ④ ToolSearch 发现性：会话内搜「PPT/麦肯锡」能发现并激活 `ppt_master_status`；
- ⑤ **S10 重放通过**：路由命中 L2（R1 销项）；Stage-1/Stage-2 两次在 chat 停下等待用户显式回复（R2 chat 级销项）；最终导出原生 PPTX（解包含 graphicFrame/SVG 派生形状）；权限拒绝 ≤2 次（R4 缓解，对照原 6 次）；R3 由 L2 天然绕开（L1 补课在 C）。
- ⑥ 文档标注：本阶段确认为 chat 级，**组织推广待 Phase B**（RP-8）。

### Phase B：确认硬门禁与脚本白名单（1.5 周）

**任务**
1. **`ppt_script` 白名单（9 项）**：`project_manager_init` / `project_manager_validate` / `source_to_md` / `text_measure_calibrate` / `quality_checker` / `finalize_svg` / `total_md_split` / `svg_to_pptx` / `image_search`——每项 argspec 与上游 argparse **逐一对照**（quality 传位置参数、finalize 传 project_dir、export 传 project_path 且 `-s` 用 project-relative 值——修复 §1.2 #3）；预计 >60s 自动转异步作业（复用 A 的作业管理器）。
2. **状态机**：`pipeline-state.json`（§4.4 schema）+ 容错（损坏/手改回退 pending 并告警；`result.json`「只读一次」语义由插件保证）。
3. **`ppt_stage_submit` / `ppt_stage_status`**：schema 校验 recommendations（上游格式）；submit 触发 openPanel + toast。
4. **MVP 确认面板**（`renderer/confirm-card.html`，ui.panel）：契约摘要 + 方向单选 + 页数 + 「确认」/「快速模式」（waiveReason 必填）；zh/en 双语；命令 `openConfirmCard`（palette 入口，只打开不确认）。
5. **导出硬门禁**：`ppt_script` 对 `finalize_svg/total_md_split/svg_to_pptx` 前置校验 stage2 ∈ {confirmed, waived} 且 spec_lock 存在（`PPT_STAGE_NOT_CONFIRMED`）。
6. **薄壳技能 v2**：确定性脚本调用从 Bash 直调切换为 `ppt_script`（Bash 保留为回退）；Stage 提交改走 `ppt_stage_submit` + 面板。

**核心参数**：`ppt_script` 单脚本同步执行阈值 60s（超过转作业）；白名单外脚本一律拒绝（`PPT_SCRIPT_NOT_ALLOWED`）；stage 状态查询缓存 5s；面板提交写 `result.json` 字段与上游 `scripts/docs/confirm_ui.md` 契约一致。
**退出指标**：① 9 个白名单 argspec 快照测试（对上游 `--help` 输出基线比对）100% 对齐；② 未确认导出拒绝率 **100%**（三态用例：无 state / submitted 未确认 / confirmed 通过）；③ 确认后面板、state 文件、result.json、`ppt_stage_status` 四路一致；④「只读一次」违规（二次读）返回警告缓存；⑤ 快速豁免 waiveReason 落盘；⑥ MVP 面板在 dev 加载模式可开（bundled 断言 entry 存在 + 截图人工审）；⑦ 真实 venv 冒烟链（`PPT_IT=1`）：md 源 → init → convert → 测试代写 design_spec/spec_lock + result.json → 2 页 SVG → checker → finalize → export → AdmZip 断言 PPTX 结构。

### Phase C：体验层与 L1 补课（2 周）

**任务**
1. **精制确认卡**（设计兼职出图）：Stage-1 契约表单 + 模板候选缩略单选；Stage-2 三方向卡片（色板/字体/构图预览）+ 开关组 + 主次操作；46px 拖拽带规范。
2. **工作台视图**（`contributes.views` + `renderer/workbench.html`，复用确认卡组件）：运行时状态卡（五态+一键 setup）/ 管线进度时间线 / **SVG 翻页预览**（渲染 svg_output/svg_final，缩放/页码/占位图提示）/ 导出卡（打开目录）。
3. **通知链完整**：submit → 原生通知 + toast；导出完成 → 通知。
4. **L1 补课（RP-7，修复 R3）**：`lib/slides.js` 用 pptxgenjs `addChart/addTable` 渲染 `data/matrix/compare/timeline`；`slides_plan` 归一化不再吞字段。
5. **产物登记探测点**：若 laboflow-v2 既有产物/版本链接口可零主干接入则接线，否则记后置（不阻塞）。

**核心参数**：预览单页 SVG ≤2MB（finalize 自包含产物）；工作台刷新轮询 2s（有活跃作业时）/10s（空闲）；翻页支持键盘 ←/→；确认卡与工作台 8 语言。
**退出指标**：① 12 版式样张渲染断言（L1 导出解包含 graphicFrame/chart xml）；② 工作台结构断言 + 手工脚本（打开/进度/翻页/导出卡四步）；③ i18n 8 语言齐全；④ L1 全量既有测试不回归。

### G：全量验收与收尾（1 周）

**任务**：AGPL 扫描固化（依赖黑名单断言进 CI 常规跑）；打包体积基线与断言（vendor 69MB→记录基线，安装包增量上限断言）；`scripts/e2e-slides.mjs`（三平台：L1 快速路径 + L2 status 诊断路径，无网络依赖）；手工验收回路（对齐官方教程 §9：启用/禁用/重载/卸载/日志检查 + §6.3 十场景）；Gate 全量回归 + phase5 README 执行记录 + RP-1…RP-8 裁决并入 + ACCEPTANCE 勘误关联；遗留后置项单列（AI 生图密钥方案、离线 wheelhouse、icons 子集化瘦身、产物版本链接入、组织模板包下发 T56.10）。

**退出指标**：§6.2 指标表全绿；Gate（lint/typecheck/三平台 E2E/desktop+host-core+agent-runtime+server 测试）不低于既有基线（desktop 1353 pass / host-core 307 / agent-runtime 309 / server 202+2 既有）。

### 里程碑总览

| 阶段 | 工期 | 交付 | 关键指标 | 价值节点 |
|---|---|---|---|---|
| M0 治理 | 0.5 周 | 勘误+测试基线+卫生 | ≥6 断言；0 .pyc | — |
| **Phase A 等价移植** | 2 周 | 4 工具 + 薄壳技能 + venv/uv + chat 确认 | S10 重放通过；setup ≤5–8 分钟 | **第 2.5 周可用 L2（beta）** |
| Phase B 硬门禁 | 1.5 周 | ppt_script 9 项 + 状态机 + MVP 面板 | 未确认导出拒绝率 100%；argspec 9/9 | 组织推广解锁 |
| Phase C 体验层 | 2 周 | 精制确认卡 + 工作台 + L1 补课 | 12 版式渲染断言；8 语言 | 完整体验 |
| G 收尾 | 1 周 | e2e + 扫描 + 体积 + Gate | §6.2 全绿 | 验收关闭 |

---

## 6. 验收及测试计划（遵照 Pi / Pi-Desktop 规范）

### 6.1 测试分层（对齐仓库既有框架 + Pi 官方设施，标注交付阶段）

| 层 | 框架/设施 | 位置 | 门控 | 交付 | 增量目标 |
|---|---|---|---|---|---|
| 插件纯逻辑单测 | `node --test`（无 host，沿用 lib 无 pi.* 设计） | `slides-plugin.test.mjs`、`ppt-master-runtime.test.mjs`、新增 `ppt-read-doc.test.mjs`（A）、`ppt-pipeline-state.test.mjs`、`ppt-script-whitelist.test.mjs`（B） | CI 常规 | A/B | ≥25 用例（现 8） |
| 宿主集成（官方唯一测试设施） | `@pi-desktop/plugin-sdk` **mock host** | `ppt-plugin-host.test.mjs`（工具注册/权限声明/Plan 模式拒绝/技能 frontmatter 校验） | CI 常规 | A/B | ≥10 用例 |
| 真实 Python 集成 | 真 venv + 上游脚本 | `ppt-master-e2e-python.test.mjs`（A：setup/guard/freeze 冒烟；B：全链冒烟 + argspec 快照） | `PPT_IT=1`（本地/可选 CI job，带 pip 缓存） | A/B | 冒烟 2 条 + 快照 9 条 |
| bundled 结构断言 | `node --test` | `bundled-plugins.test.mjs` 增 laboflow.slides 组 | CI 常规 | M0/A/B/C | ≥10 断言 |
| 桌面 E2E | `scripts/e2e-*.mjs` 模式 | 新增 `scripts/e2e-slides.mjs`（三平台矩阵） | Gate | G | 1 脚本 ≥3 断言路径 |
| 手工 UX 回路 | 对齐官方教程 §9（实装→禁用/启用→卸载→日志按 pluginId 过滤）+ §6.3 场景 | 验收记录 | 各阶段 Gate | A/B/C/G | 10 场景全过 |

规范符合性检查单（每次 Gate 复核）：manifest 权限与实际使用一致（无「声明未用」警告）；工具名/命令名命名空间合规（`plugin_laboflow_slides_*` / `plugin.laboflow.slides.*`）；技能 ≤32 个/≤128KiB/描述 ≤240 字符；设置无密钥；面板用 `var(--pi-plugin-titlebar-height)`；`pi-plugin check` 对插件目录跑一遍零错误（bundled 不走 .piplug，但 check 规则同源，作为结构回归线）。

### 6.2 验收指标表

| 指标 | 目标值 | 测量方法 | 验收阶段 |
|---|---|---|---|
| L2 管线触发率 | 「麦肯锡/精品/咨询风格 PPT」类 10 条 prompt 集 ≥9 条路由到 L2 | S10 扩展场景集（人工+ToolSearch 日志） | A |
| 确认强制性（chat 级） | Stage-1/2 均在 chat 停下等待用户显式回复（10 场景 ≥9） | 场景测试 | A |
| 确认强制性（工具级） | 无 result.json 时导出类脚本拒绝率 **100%** | 自动化三态用例 | B |
| 环境自愈 | 全新机器 status(venv-missing)→setup→ready：uv ≤3 分钟 / 镜像 pip ≤5 分钟 / 直连 ≤8 分钟 | `PPT_IT=1` 集成计时 | A |
| 长任务 | 30 页 deck export 异步作业完成 ≤5 分钟；插件重载后作业状态可查（interrupted） | 集成测试 | B |
| 协议保真 | 上游文件（recommendations/result/design_spec/spec_lock/质检报告）字段与上游 schema 零偏差 | 快照测试 + 上游 `project_manager.py validate` 通过 | A/B |
| 许可合规 | pip freeze 黑名单（fitz/PyMuPDF/pandoc/edge-tts/ebooklib/flask）零命中；guard 通过；VENDOR_LICENSES 更新 | CI 断言 | A，G 固化 |
| 体积 | 安装包增量 ≤75MB（现状 vendored 69MB + 插件代码）；树内 0 `.pyc` | 打包脚本断言 | G |
| L1 质量 | 8 版式全部真实渲染（data/matrix/compare/timeline 含原生 chart/table） | 解包断言 | C |
| 回归 | Gate 全绿：desktop ≥1353+新增、host-core 307、agent-runtime 309、server 202+2（既有）；lint/typecheck/三平台 E2E 过 | Gate 矩阵 | G |

### 6.3 验收场景（10 个用户旅程，标注验收阶段）

| # | 场景 | 阶段 |
|---|---|---|
| S10 | **失败会话原 prompt 重放**（茂名脚本稿 + 「使用 SLIDES 插件」话术）：路由进 L2、两次停下等确认、图表由 SVG 管线产出、权限拒绝 ≤2 次 | **A** |
| S3 | PDF 源拒绝与引导文案（preamble 级 → B 的 ppt_script 友好拒绝） | A/B |
| S5/S6 | venv 缺失→status 诊断→setup 自愈；uv 缺失回退系统 python（含版本不足报错） | A |
| S9 | Plan 模式下技能给出模式切换提示 | A |
| S7 | split 跨会话续跑（新会话「继续生成 projects/x」恢复进度） | A/B |
| S2 | 麦肯锡精品全管线（Stage-1/2 面板确认 + 翻页预览 + 导出） | B/C |
| S4 | 未确认导出被硬门禁拦截（三态） | B |
| S8 | 显式快速模式（豁免链路 + waiveReason 落盘） | B |
| S1 | 快速大纲（L1 全链路含确认 + 四版式真实渲染） | C |

### 6.4 推广解锁门与文档同步

- **Phase A 合入**：默认启用可带 beta 标注，自用/内测可用；**组织侧推广在 Phase B 合入后解锁**（RP-8：chat 级确认不满足组织场景的可靠性要求）。
- 每阶段退出即跑模块 Gate（§6.1 对应分层项）；G 跑全量 Gate 并在 phase5 `README.md` 追加执行记录（沿用惯例），同时把 RP-1…RP-8 裁决并入 §4 裁决表、勘误 ACCEPTANCE。遗留后置项（AI 生图密钥方案、离线 wheelhouse、icons 子集化瘦身、产物版本链接入、组织模板包下发 T56.10）单列清单不阻塞验收。

---

## 附：证据与参考索引

- 插件现状：`apps/desktop/resources/plugins/laboflow.slides/{manifest.json, main.js, lib/ppt-runtime.js, skills/slides.md, vendored/ppt-master/}`
- 失败会话：`~/.pi-desktop/sessions/3bd626ab-42fc-4c6a-ada4-657b18df2a18.jsonl`（pi.sqlite sessions 表同名标题）
- PPT-Master 本体：`/Users/lance/AI/Skills/ppt-master`（重点：`skills/ppt-master/SKILL.md`、`workflows/{routing,generate-pptx}.md`、`references/{strategist,confirm-surface,executor-base}.md`、`scripts/docs/confirm_ui.md`、`.claude-plugin/marketplace.json`、`skills/.claude-plugin/plugin.json`）
- Pi 插件规范：pi-docs.aiuo.net `/plugin-development` 与 `/spec/07-plugins/` 01–16（关键：02 manifest schema、04 security、12 IPC/超时预算、13 权限矩阵、10 devex/测试）；根站 `/spec/03-runtime/02-agent-runtime`（ToolSearch 按需激活）、`/spec/03-runtime/03-tools-and-permissions`（子代理不可分配插件工具）
- 仓库规范：phase5 `README.md` §6（Gate 矩阵/安全自查/i18n/文档同步）、根 `package.json`（test/typecheck/lint/e2e 命令）、`.github/workflows/ci.yml`
