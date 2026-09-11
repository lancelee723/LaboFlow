# SPEC：高级 PPT 制作助手（模块 06）

| 文档属性 | 内容 |
|---|---|
| 版本 | v1.0（草案） |
| 日期 | 2026-09-11 |
| 关联 | [PRD](PRD.md)、[PLAN](PLAN.md) |
| 变更面 | 新内置插件 `laboflow.slides`（agentTools/skills/views）、electron/main（ppt-runtime.ts Python 管理器）、渲染层（大纲流/翻页器/工作台面板）、apps/server + admin-console（组织模板包） |

---

## 1. 架构总览

```
会话（Agent 循环）
 ├─ 意图路由（"做PPT"/$slides）→ slides 技能
 ├─ L1: slides_plan → slides_render → slides_export（纯 JS，pptxgenjs）
 └─ L2: ppt_plan → ppt_batch_generate(前5页门禁→质检→其余)
          → ppt_finalize → ppt_export（Python 子进程，vendor PPT-Master）
        ▼ 工具执行（主进程）
 SlidePluginService
 ├─ L1 SlidesService（JS 移植：大纲规范化/渲染/导出）
 ├─ L2 PptMasterBridge（子进程编排 + 工作目录隔离 + 进度事件）
 │    └─ ppt-runtime.ts（python/uv 检测→venv→依赖→自检断言）
 └─ deck manifest（双引擎统一中间表示）→ 产物登记（kind=slides 版本链）
        ▼ UI
 大纲确认卡 / 预览翻页器 / 工作台面板（大纲树+缩略图+版本） / 导出目的地
```

**核心架构决策**：

1. **插件承载，主干零改动为目标**（ADR-P1，R5-10）：全部能力落在内置插件 `laboflow.slides`（`contributes.agentTools + skills + views + settings`，先例=`pi.browser`）。主干触点例外清单（穷尽）：① 工作面板 tab 经插件 `contributes.views` 注册（既有机制，无主干改动）；② 产物登记调用 `artifacts` 既有 RPC（无改动）；③ 会话流「大纲确认卡/翻页器」为渲染层卡片组件扩展（非引擎改动）。除此之外**不改** `electron/main/index.ts` 主干与 host-core；引擎可整体启停/升级（换插件版本）。
2. **双引擎、一中间表示**（ADR-P2）：deck manifest（JSON：元信息/大纲树/页列表（版式、内容块、资产引用、状态）/导出记录）为两引擎共同产物描述；UI（大纲流/翻页器/工作台）只读 manifest，与引擎解耦。
3. **PPT-Master 以「黑盒工序」集成**（ADR-P3）：vendor 目录原样保留，只经脚本边界（stdin/args/文件）驱动，不 import 其代码、不改其内部；每次升级=换目录+跑适配回归。LLM 创作步骤（逐页 SVG 手写）由 LaboFlow 的 agent 承担（技能装载引导），确定性步骤由 Python 工具承担。
4. **Python 隔离与封禁**（ADR-P4，合规）：独立 venv（`<userData>/ppt-runtime/venv`）；requirements 裁剪（去 pymupdf/pandoc 相关）；路由黑名单（PDF 转换路由不可达）+ 启动自检断言（import 检查，失败即禁用 L2 并报「LaboFlow 禁用该路径」）。

## 2. 数据模型

### 2.1 deck manifest（文件形态，`<deckDir>/deck.json`）

```json
{
  "id": "deck_<uuid>", "engine": "l1|l2", "title": "...",
  "theme": {"templateId": "org:corp-blue|personal:...|builtin:consult"},
  "pages": [
    {"no": 1, "layout": "title|bullets|data|matrix|compare|timeline|quote|end",
     "title": "...", "blocks": [...], "notes": "...",
     "status": "planned|generating|done|failed",
     "assets": {"svg": "P01.svg", "png": "P01.png"},        // L2
     "source": {"enginePageRef": "P01"}}
  ],
  "contract": {"specLock": "spec_lock.md", "designSpec": "design_spec.md"},  // L2
  "exports": [{"format": "pptx", "file": "...", "at": "...", "postflight": {...}}],
  "budget": {"tokensEstimated": 0, "tokensUsed": 0, "capped": false}
}
```

deck 工作目录：`<projectDir>/.laboflow/decks/<deckId>/`（L2 的 svg_output/svg_final 与 manifest 同目录），登记产物时以导出文件为准（版本链沿用 `artifacts` 机制）。

### 2.2 模板资产

- 个人：`~/.laboflow/slide-templates/<id>/`（`template.json`：名称/画幅/色彩锚点/字体/版式偏好 + 参考文件）；蒸馏产物（Brand/Style/Layout 契约文件）同目录。
- 组织：服务端 `org_slide_templates(id, org_id, name, files 存储, contract JSONB, version, enabled, ...)`；bootstrap 载荷 `slideTemplates[]`；客户端落个人目录 `source=org` 只读副本。

### 2.3 host-core

无新表（产物走 artifacts 既有；插件数据走 plugins data 目录）。插件 settings（引擎默认/预算/镜像源）走 `contributes.settings`。

## 3. 关键设计

### 3.1 agentTools 契约（插件 `contributes.agentTools`）

| 工具 | 引擎 | 入参 → 出参 | 说明 |
|---|---|---|---|
| `slides_plan` | L1 | `{topic, sources[], pageCount?, style?}` → `{outline}` | 结构化大纲（LLM 结构化输出经 one-shot 或会话内调用） |
| `slides_render` | L1 | `{deckId, outline}` → `{manifest}` | 逐页中间表示生成 |
| `slides_export` | L1 | `{deckId, format:'pptx'}` → `{file, pages}` | pptxgenjs 导出 |
| `ppt_plan` | L2 | `{sources[], templateId?, audience?}` → `{designSpec, specLock}`（内容呈现用户确认） | Strategist 工序 |
| `ppt_batch_generate` | L2 | `{deckId, pages, batch:'first5'\|'rest'}` → 进度事件+`{svgFiles}` | Executor 工序（模型逐页 SVG）；质检脚本门禁 |
| `ppt_finalize` | L2 | `{deckId}` → `{notesMd, svgFinal}` | 备注拆分/预览定稿 |
| `ppt_export` | L2 | `{deckId, options{nativeCharts?}}` → `{file, postflight}` | svg→pptx 转换+自检 |
| `ppt_quality` | L2 | `{deckId, page?}` → `{issues[]}` | 质量检查（门禁用） |

权限类：全部归入 `slides.*` 规则族（默认 accept-edits 类，导出写文件走既有文件权限）。

### 3.2 PptMasterBridge（子进程编排）

```
run(script, args, {cwd: deckDir, timeout, onStdout})
  ├─ spawn(python, [venv/bin/python, <skill>/scripts/<script>, ...args])
  ├─ stdout NDJSON 解析（进度/结果），非 JSON 行进日志
  ├─ 超时/崩溃 → kill + 重试 1 次 → 仍败则工具返回结构化错误（manifest 页状态 failed）
  └─ 环境变量：工作目录/镜像源/禁用标志（PPT_MASTER_DISABLE_PDF=1 等）
```

- 生成是「模型逐页写 SVG 文件」+「脚本质检/转换」交替：`ppt_batch_generate` 由插件协调（agent 写文件 → 调 `ppt_quality` → 不过则带 issues 重写，≤2 轮）。
- 中断续跑：manifest 页状态即断点（planned/generating/done）；重入只跑非 done 页。

### 3.3 ppt-runtime.ts（Python 运行时）

- 探测序：`uv`（推荐，`uv venv + uv pip install`）→ 系统 `python3`（版本 ≥3.10 校验）→ 引导页（安装 uv 或手动指路径）。
- 依赖：vendor `requirements-laboflow.txt`（上游 requirements 裁剪：移除 pymupdf；pandoc 为系统二进制不装）；pip 镜像源可配（默认清华源，组织可下发覆盖）。
- 自检断言：`python -c "import ppt_master_guard"`（vendor 内守卫模块：assert 未安装 pymupdf、attribution 文件存在）→ 失败禁用 L2。
- 状态机：`missing → installing → ready | failed(diag)`，设置页可视化；卸载/重装入口。

### 3.4 会话编排与成本

- 意图路由：技能描述触发（「制作 PPT/slide/deck」）；`$slides` 直达 L1。
- L2 前置检查：模型上下文 ≥128k（否→建议 L1/分批）；成本预估（页数 × 每页预估 token，向用户确认）；tool_budget 挂预算（FR-PPT-16）。
- 后台执行：deck 生成可后台（会话不阻塞），完成经任务通知（既有 notification-policy）。

### 3.5 UI 组件

- 大纲确认卡（会话流内）：表格化页列表（可增删改/版式下拉/拖拽排序）。
- 预览翻页器：缩略图条 + 当前页（L2 用 svg_final 的 PNG 渲染，L1 用中间表示渲染）；页操作菜单。
- 工作台面板：工作面板新 tab kind=`slides`（大纲树/缩略图/版本历史/对比，读 manifest+artifacts）。
- 导出卡：目的地选择（本地/交付物库/团队空间）+ postflight 摘要。

## 4. 安全与合规设计

- 子进程：仅 deck 工作目录读写；网络仅模型 API 与（可选）图片搜索域名白名单；超时硬顶。
- AGPL 封禁三重（依赖裁剪/路由黑名单/启动守卫断言），Gate 脚本化检查（扫描 venv 无 pymupdf、路由常量、attribution 文件）。
- attribution：vendor 目录保留上游 NOTICE/attribution 文件；导出的 deck 不携带（产物为用户数据）；LaboFlow 关于页增加「PPT-Master (MIT)」致谢条目。
- 素材：图片搜索默认关；开启时仅白名单域（Pexels/Pixabay/Openverse），密钥存 host secrets。

## 5. 测试策略

| 层 | 用例 |
|---|---|
| 单测 | 大纲规范化/版式枚举（L1 移植回归）；manifest 状态机（中断续跑/页重生成）；runtime 探测/裁剪/守卫断言；成本预估 |
| 集成 | L1 全链路（mock 模型）；L2 桥（真实 Python + 固定 SVG 夹具：质检门禁/转换/postflight/崩溃重试）；封禁断言 |
| E2E | 「材料→大纲→确认→L2 生成→预览→导出→入交付物库」；预算中断恢复；引擎切换 |
| 抽检 | 三端（PowerPoint/WPS/LibreOffice）可编辑性清单；中文字体重排用例集 |
| 盲评 | 双引擎对比样张（同任务 ×5），顾问 ≥4/5（Gate PPT 件） |
