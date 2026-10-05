# ADR 0040: PPT 助手单引擎——只保留 vendored PPT-Master

- Status: Accepted
- Related: FR-PPT-03, RP-7, docs/laboflow/phase5/06-ppt-assistant/PPT-MASTER-PLUGIN-DEVPLAN.md,
  docs/laboflow/phase6/PPT-MASTER-DUAL-TRACK-BOUNDARY.md (archived)

## Context

LaboFlow 的 PPT 助手最初是双引擎（FR-PPT-03 / RP-7）：

- **L1 快速引擎**（自研）：`slides_plan` / `slides_export` 两个 agent 工具 +
  vendored pptxgenjs，把 agent 起草的大纲直接导出为可编辑 PPTX，秒级、零依赖。
- **L2 精制引擎**（vendored 上游 PPT-Master）：Agent 按语料规程产出 SVG 页面，
  经 Python DrawingML 编译器导出咨询级原生 PPTX，分钟级、需要隔离 Python 运行时。

两个引擎共享同一个插件 `laboflow.slides`。实测与失败 RCA（2026-09-12）表明：
L1 的"快速"产物质量距用户预期（茂名脚本稿→麦肯锡风格）太远，宁可等待 L2 也不应
交付 L1 层级的初稿；双入口还让用户在 `/` 技能菜单里看到相互冲突的 `slides` 与
`ppt-master` 两条路径。用户裁决（2026-10-05）：**L1 没有存在的必要**，同时要求
L2 运行时预置进应用，而不是让用户初次使用时现场下载。

评估过的替代方案：

- **pi-powerpoint（pi.dev / tmustier，MIT）**：Pi skill，包装
  office-powerpoint-mcp-server（python-pptx，34 工具）。能力面比 L1 宽
  （图片/形状/连接线/模板/读取已有 PPTX），但运行链需要 Bun 或 Node CLI +
  uvx 首跑从 PyPI 拉取 Python 服务端，且上游存在演示状态存于服务端内存、
  跨调用丢失的缺陷（靠 batch 包装规避）。它不满足"零依赖、即刻可用"的 L1
  定位；其生成质量层级与 L1 相当（模板填充，非设计系统），引入它等于用更重
  的依赖链重演 L1 的信任问题。**不采用**；若未来出现"编辑已有 PPTX"的产品
  需求，其底层 office-powerpoint-mcp-server（MIT）可经已预置的 uv 运行时
  复用，届时另行立项。
- **保留瘦身版自研 L1**：被用户裁决否决；质量根因（快速生成伤信任）不因
  减少版式而消除。

## Decision

1. **单引擎**：删除 L1 全部痕迹——`slides_plan` / `slides_export` 工具、
   `lib/slides.js`、`skills/slides.md`、`vendor/`（pptxgenjs）、
   `scripts/e2e-slides.mjs`、对应测试；`builtin-experts` 的「PPT制作师」仅绑定
   `ppt-master` 技能；FR-PPT-06 工件链只认 `ppt_script`(svg_to_pptx)。
   插件版本升至 3.0.0（破坏性：移除两个公开工具与两个设置项 accentColor /
   outputDir）。
2. **运行时预置**（FR-PPT-17）：
   - 插件加载 10s 后后台自动 `ensureRuntime`（复用 setup 作业去重），就绪则
     静默跳过；失败仅记日志，doctor 在用户实际使用时如实呈现。
   - 打包内置离线 wheelhouse：`scripts/make-ppt-wheelhouse.mjs --bundled`
     按 CPython 3.12（与 `uv venv --python 3.12` 固定值一致）用
     `pip download --python-version 312 --only-binary=:all:` 生成
     `wheelhouse/<platform>-<arch>/`（gitignored，随 extraResources 进入
     应用包），运行时自动探测并以 `--no-index --find-links` 离线安装。
     实测 darwin-arm64 21 轮子 / 20.8 MiB，离线安装全量导入通过。
   - 入口收敛：`/` 菜单只保留 `laboflow.slides/ppt-master` 技能；新增
     「新建 PPT」命令作为路标（当前插件 API 无法预填输入框或打开停靠视图）。

## Consequences

- 首次使用不再有"快速但低质"的出口；所有 PPT 请求走同一确认门与质检管线。
- 打包体积 +≈21 MiB/平台（wheelhouse）；无网络环境可完成安装（需 uv 或
  Python ≥3.10；非 3.12 解释器的兜底 pip 安装仍走在线镜像）。
- 移除了两个公开工具与两个设置项——升级用户若曾依赖 L1 导出，需要改走
  PPT-Master 管线（一次性迁移，无持久化数据兼容问题：L1 产物是普通 PPTX 文件）。
- `docs/laboflow/phase5/06-ppt-assistant/` 与 phase6 边界文档中关于双引擎的
  表述由本 ADR 覆盖；对应文档已归档至 `docs/laboflow/archive/`。
