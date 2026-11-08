---
name: ppt-master
description: Vendored PPT-Master pipeline: consulting-grade native editable PPTX (麦肯锡/咨询风格精品PPT). Use for 新建/制作/生成/美化PPT、幻灯片、演示文稿、汇报材料, new/create/beautify/redesign a presentation/deck/slides, or ppt-master.
---

# PPT Master（LaboFlow 薄壳）

上游 PPT-Master（vendored，MIT，pin 见 `VENDOR_VERSION`）在此宿主中的运行约定。**以下 9 条是硬性前置，优先级高于上游正文；正文原样生效。**

1. **路径引导（先做）**：任何 PPT-Master 工作开始前，先调用工具 `ppt_master_status`（工具全名 `plugin_laboflow_ppt_master_ppt_master_status`）。返回的 `skillDir` 就是上游正文中的 `${SKILL_DIR}`，`pythonPath` 是唯一合法解释器。**禁止猜测、搜索或假设路径**（对齐上游 "never search or guess"）。若 stage 非 ready：按 `doctor` 处理（通常调用 `ppt_master_setup` 后用 `ppt_job_status` 轮询安装作业，成功后再 status 确认）；运行时通常已在应用启动时自动预置，也可用 ppt_master_setup 手动重装。
2. **语料读取**：正文中的 `Read <path>`（workflows/…、references/… 等）一律用工具 `ppt_read_doc`（传语料库相对路径）。不要用 Bash cat——语料在工作区沙箱之外。
3. **脚本执行**：白名单内的 9 个脚本（project_manager/source_to_md/text_measure/quality_checker/finalize_svg/total_md_split/svg_to_pptx/image_search/pptx_template_import）**一律优先用 `ppt_script` 工具执行**（>60s 自动转后台作业，不占满宿主 RPC 预算槽）；仅白名单外的辅助命令才用 `Bash: PYTHONDONTWRITEBYTECODE=1 <pythonPath> <skillDir>/scripts/…`（用 ppt_master_status 返回的绝对路径展开 `${SKILL_DIR}`；`PYTHONDONTWRITEBYTECODE=1` 前缀必须保留——应用包只读，字节码缓存在正式安装上会直接报错）。每命令一次独立调用，禁止 cd、禁止批量 shell 循环（对齐上游纪律）。**项目必须建在工作区**：`project_manager.py init` 必须传 `--dir <工作区>/projects`（用 ppt_script 白名单工具会强制校验）——上游默认把项目建进 skill 目录（LaboFlow 中为只读应用资源），绝不允许。**大文件分块写入**：单页 SVG 通常 8–14KB，超过模型单次输出上限——先 Write 骨架（`<svg>`+defs，≤2KB），再用连续 Edit 逐块追加（每块 ≤3KB）直至 `</svg>` 闭合；禁止单次 Write 整页。**门禁脚本例外**：`finalize_svg`、`total_md_split`、`svg_to_pptx` 三个脚本**禁止用 Bash 直跑**，必须走工具 `ppt_script`——Stage-2 确认硬门与导出工件登记只在该工具路径上生效，Bash 旁路会绕过确认门并丢失工件登记（走查发现 F-3）。
4. **确认面（工作台唯一）**：两阶段确认（Stage-1 沟通契约+模板选择、Stage-2 三个设计方向）**必须**调用工具 `ppt_stage_submit`（`{projectDir, stage, recommendations}`）提交，决策只发生在右侧 PPT 工作台的「设计确认」区。提交后在对话中完整呈现方案内容 + 指引「请在右侧 PPT 工作台确认」，然后**停下轮询 `ppt_stage_status`**——沉默不构成确认。**禁止**：用 asktool/弹窗征询确认；在对话内以问答形式完成确认；代用户确认；把用户沉默视为确认。用户明确要求"快速生成/跳过确认"时，走工作台的「豁免」按钮（需理由），而非对话确认。**确认状态属于项目，不属于对话记忆**：换新项目或重建项目后，即使用户口头说"已确认/继续"，也必须对新 projectDir 重新走 `ppt_stage_submit` → 工作台确认；禁止把旧项目或对话中的确认沿用为门禁凭据。上游 confirm-surface.md 中"启动确认页（Flask confirm_ui）"分支不可用（本环境未安装 flask）。
5. **禁用路线**：PDF 源转换（PyMuPDF，AGPL 规避）不可用——用户给 PDF 时请其先转 docx/md 或粘贴文本；旁白 TTS 与 .epub 输入不可用。其余路线（DOCX/XLSX/PPTX/URL/MD/主题、模板、编辑原生 PPTX）可用。
6. **宿主权限提示**：本管线需要 Bash 权限。会话权限为 ask 模式时，先提示用户切换到 accept-edits/auto，避免逐步授权打断管线（历史失败主因之一）。**子代理不可用插件工具与技能——整个管线必须在主会话执行**，不要尝试派生子代理。
7. **页级操作语义（FR-PPT-04）**：用户要求删除/重排/重生成单页时——删除与重生成由工作台 `ppt.pageAction` 通道完成（页面入 `backup/pageActions-*/` 可恢复，final 质检报告自动失效）；Agent 重写页面后**必须**：① 若 NN 序号变化，同步重排其余页与 design_spec §IX roster（v6.6.0 checker 强制 roster 数量一致）；② 重跑 `quality_checker --stage final`；③ 再导出。用户在会话里说「重新生成第 N 页」时，按上游 resume 语义只重写该页，不要全量重跑。

8. **跨会话续跑**：用户在新会话说"继续生成 projects/<name>"时：先 `ppt_master_status` 取路径，再 `ppt_read_doc` 读 `workflows/stages/resume-execute.md`，以项目目录文件（design_spec/spec_lock/svg_output）恢复进度，不依赖会话记忆。

9. **宿主托管预览（live-preview）**：绘制阶段启动上游实时预览的方式为——用工具 `ppt_script` 执行 `svg_editor`（参数：`{"action": "daemon", "projectDir": "<项目绝对路径>"}`，白名单内已转后台作业），随后告知用户预览已在系统浏览器打开（端口记录于 live_preview/lock.json，宿主负责打开浏览器）；**禁止用 Bash 前台/裸后台方式启动任何预览或 confirm 服务**。用户在网页上的拖拽/批注经 Apply changes 落回 svg_output 后，按上游 live-preview Stage 2 规程应用注解并重跑质检导出；用户要求停止时用 action=shutdown。用户在预览页点击 Exit preview 关闭服务后，宿主会自动向本会话注入收尾指令（应用批注→重跑质检导出）：收到该注入视为用户已请求应用批注，立即按规程执行，不要再次询问。

---



# PPT Master Skill

PPT Master is a routed presentation workflow. This entry owns global execution discipline and route selection only; each selected route owns its procedure.

## Mandatory Load Order

**Hard rule — paths before commands**: Retain the host-provided absolute
directory containing this file as `SKILL_DIR`. Per tool call, expand
`${SKILL_DIR}` and replace any `skills/ppt-master/` prefix with it. Never `cd`,
use CWD, or assume a repo checkout. If unavailable, ask; never search or guess.

1. Read this file.
2. Run `python3 "${SKILL_DIR}/scripts/attribution_guard.py"`. Any non-zero result
   stops the Skill immediately; do not inspect, repair, or bypass the integrity
   gate.
3. Read [`workflows/routing.md`](workflows/routing.md) through the concrete
   absolute path `${SKILL_DIR}/workflows/routing.md`.
4. Select exactly one top-level route and its active profile from the routing
   authority.
5. Read only the resulting runtime authority and its explicitly triggered
   supporting documents.

| Selected route / profile | Runtime authority |
|---|---|
| Generate PPTX — Image to PPTX | [`workflows/profiles/image-to-pptx.md`](workflows/profiles/image-to-pptx.md); Codex-supported, always Quick |
| Generate PPTX — Beautify | [`workflows/profiles/beautify-pptx.md`](workflows/profiles/beautify-pptx.md); explicit Quick intent selects Quick, otherwise Default |
| Generate PPTX — ordinary Default | [`workflows/generate-pptx.md`](workflows/generate-pptx.md) |
| Generate PPTX — ordinary explicit Quick | [`workflows/profiles/quick-generate.md`](workflows/profiles/quick-generate.md) |
| Create Template | [`workflows/create-template.md`](workflows/create-template.md) |
| Edit Native PPTX | [`workflows/edit-native-pptx.md`](workflows/edit-native-pptx.md) |

**Hard rule — selected authority only**: Do not load another top-level route's
procedure after routing. Image to PPTX and Beautify are mutually exclusive;
Image to PPTX activates Quick, while Beautify selects from explicit Quick
intent. Never load both runtimes. Supporting documents refine one route; they
never compete with it.

---

## Authored Expression Range

**Reference — not a constraint**: what a generated page can carry. Text — inline
emphasis runs, lead-in, kicker, pull quote, hero number, takeaway line. Geometry
— 187 Office presets, Boolean merge, connectors, freeform, page-field and
outline-carrier composition. Image — full-bleed field, editorial crop, shaped
picture, registered layers, scrim and spotlight, cross-page continuity. Paint —
gradients, channel alpha, native shadow and glow, halftone, faceted form.
Recurrence — one cross-page motif varied by page role. Each form's syntax lives
in the selected runtime authority's construction references.

---

## Vocabulary

One meaning per term across every loaded file. Where a word is used in
more than one sense, the sense is named here and the files say which one.

| Term | Meaning |
|---|---|
| **Reference** (label) | A starting sketch the executing role adjusts or replaces freely, with no upstream repair or stated reason; `(binding)` after a field label removes that freedom |
| **Relationships** | The §IX line naming a page's semantic units and their source-stated `order` / `link` / `parent` / `membership` / `contrast` / `overlap`, or `none` |
| **Topology decision** | The per-page yes/no on whether geometry must carry the page's `Relationships` (`topology=yes` / `topology=no`); unrelated to `pptx_structure.mode` |
| **`pptx_structure.mode`** | `flat` (every object Slide-local) or `structured` (declared Master/Layout/slot metadata); a packaging route, never information structure |
| **Composition** | The §IX `Composition` line: a Reference for a page's macro composition, hierarchy, and focus |
| **Image pattern** | The §VIII column carrying one image-composition suggestion in ordinary words (optionally citing `#P`/`#M` ids) |
| **Layout** | A PowerPoint Layout under a Master, or the Layout template kind; never a page-composition sketch |
| **Device** | An everyday page carrier — card, band, icon-and-label, KPI tile, divider, quote block — recalled in the Executor's device menu |
| **Carrier** | What a page unit sits in: a device, an image, or native geometry; the family names are carrier and field, direction and sequence, grouping and ownership, emphasis and annotation. `data-pptx-carrier` is a structured-slot attribute, not this term. The **carrier receipt** is the checker's per-page inventory of what was actually drawn |
| **Page job** | What one page must do for the reader; the input every carrier, contour, and effect decision is judged against |
| **Page field** | One large surface, outline, aperture, or off-canvas contour that organizes zones instead of a card per unit |
| **Contour / preset / atom** | A contour is a shape's silhouette; a preset is one of the 187 Office `prst` contours drawn through `preset_shape_svg.py`; an atom is one object that compiles to one DrawingML shape |
| **Geometry signature** | The retained line `page job → composition move → contour / edge language` kept per page and compared before the next page |
| **Texture** (of a block) | Whether a §IX block is prose, bullets, keywords, or labels; distinct from visual texture (grain, halftone) |
| **Anchor** | Two senses: a lock anchor (a deck-wide color, type, or spacing value) and the `page_rhythm` tag `anchor` for structural pages |
| **Sheet / slice / plate** | A sheet is one generated image holding several elements on a chroma key; a slice is one element cut from it; a plate is a registered full-canvas layer of several non-overlapping objects |
| **Module line** | The `P<NN> modules: …` line written before each page naming the triggered modules it uses |
| **Mode** | Named by qualifier: communication `mode` (how the deck argues), reading mode (`consumption_mode`), `generation_mode` (`continuous` / `split`), `pptx_structure.mode`, `replication_mode` (how a template was created) |

## Phase Frame

Every route is one Plan → Do·Check·Act cycle: Plan ends when every authoring
input exists as a file or retained decision; Do authors pages, Check runs the
route's gates, Act repairs at the owning layer (discipline 7), and the cycle
ends at export. Step numbers stay as written.

| Phase | Default | Quick | Edit Native | Create Template |
|---|---|---|---|---|
| **Plan** | Steps 1–5 | §2 | §1–4 | Steps 1–3 |
| **Do·Check·Act** | Steps 6–7 | §3–4 | §5–7 | Steps 4–8 |

## Global Execution Discipline

1. **Serial execution** — Follow the selected authority's steps in order. A completed non-blocking step may continue directly to the next eligible step.
2. **Blocking means stop** — At every `⛔ BLOCKING` gate, wait for explicit user confirmation. Do not decide on the user's behalf.
3. **No cross-phase bundling** — Do not combine work across an unclosed gate. Once the route's final user gate closes, later non-blocking steps may continue automatically.
4. **Gate before entry** — Verify every listed prerequisite before entering a step.
5. **No speculative execution** — Do not prepare later-phase artifacts before their owning step.
6. **Deterministic routing** — Do not add a route-choice question when [`routing.md`](workflows/routing.md) resolves the request. If a route prerequisite is missing, state it and stop that route.
7. **Act at the owning layer** — On failure, repair at the shallowest layer that owns the fault: the page for a page-local issue, the Plan artifact for a roster/spec/resource fault, the owning source artifact for a tool failure; then resume from the route's declared pointer. Do not silently downgrade a required artifact.

## Global Communication Rules

- Match the user's language and source language unless the user explicitly overrides it.
- Localize user-facing option labels and explanations. Keep exact enum IDs or field names when needed for precision.
- Keep `design_spec.md` section headings and field names in the template's original English; content values may use the user's language.
- Before switching roles, read the corresponding role reference and output:

```markdown
## [Role Switch: <Role Name>]
📖 Reading role definition: references/<filename>.md
📋 Current task: <brief description>
```

---

## Repository Compatibility

- This package is a workflow/skill, not a generic application scaffold. Do not create `.worktrees/`, `tests/`, branch workflows, or generic engineering structure by default.
- Keep required workflow, reference, script, and template documentation inside this Skill directory.
- Repository-level documents may point into the package; package runtime files must not depend on repository-level instructions.
- On Windows, if a documented `python3 ...` command is unavailable, rerun the same command with `python`.
- Sponsor information is optional reference material. Read the matching [`SPONSORS.md`](SPONSORS.md) or [`SPONSORS_CN.md`](SPONSORS_CN.md) only when the user explicitly requests a model, AI image model, API/provider, or hosted-service recommendation. Never surface sponsor or model recommendations proactively during normal generation, troubleshooting, or quality review.
