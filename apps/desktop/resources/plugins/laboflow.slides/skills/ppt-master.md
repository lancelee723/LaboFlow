---
name: ppt-master
description: Vendored PPT-Master pipeline: consulting-grade native editable PPTX (麦肯锡/咨询风格精品PPT). Use for 制作/生成/美化PPT、幻灯片、演示文稿、汇报材料, create/beautify/redesign a presentation/deck/slides, or ppt-master. Quick plain decks: slides-l1.
---

# PPT Master（LaboFlow 薄壳）

上游 PPT-Master（vendored，MIT，pin 见 `VENDOR_VERSION`）在此宿主中的运行约定。**以下 7 条是硬性前置，优先级高于上游正文；正文原样生效。**

1. **路径引导（先做）**：任何 PPT-Master 工作开始前，先调用工具 `ppt_master_status`（工具全名 `plugin_laboflow_slides_ppt_master_status`）。返回的 `skillDir` 就是上游正文中的 `${SKILL_DIR}`，`pythonPath` 是唯一合法解释器。**禁止猜测、搜索或假设路径**（对齐上游 "never search or guess"）。若 stage 非 ready：按 `doctor` 处理（通常调用 `ppt_master_setup` 后用 `ppt_job_status` 轮询安装作业，成功后再 status 确认）；用户着急时可先走 slides-l1 快速引擎保底。
2. **语料读取**：正文中的 `Read <path>`（workflows/…、references/… 等）一律用工具 `ppt_read_doc`（传语料库相对路径）。不要用 Bash cat——语料在工作区沙箱之外。
3. **脚本执行**：正文中的 `python3 "${SKILL_DIR}/scripts/…"` 一律改为 `Bash: PYTHONDONTWRITEBYTECODE=1 <pythonPath> <skillDir>/scripts/…`（用 ppt_master_status 返回的绝对路径展开 `${SKILL_DIR}`；`PYTHONDONTWRITEBYTECODE=1` 前缀必须保留——应用包只读，字节码缓存在正式安装上会直接报错）。每命令一次独立调用，禁止 cd、禁止批量 shell 循环（对齐上游纪律）。**项目必须建在工作区**：`project_manager.py init` 必须传 `--dir <工作区>/projects`（用 ppt_script 白名单工具会强制校验）——上游默认把项目建进 skill 目录（LaboFlow 中为只读应用资源），绝不允许。
4. **确认面替换**：正文/`references/confirm-surface.md` 中"启动确认页（Flask confirm_ui）"的分支**不可用**（本环境未安装 flask）。两阶段确认一律走 **chat 分支**：把 `recommendations.stage1/stage2` 的内容完整呈现在对话里，然后**停下等待用户显式回复**——沉默不构成确认，禁止代用户确认（上游原文纪律原样适用）。用户明确说"快速生成/不用确认"时才可按上游 Quick profile 跳过。
5. **禁用路线**：PDF 源转换（PyMuPDF，AGPL 规避）不可用——用户给 PDF 时请其先转 docx/md 或粘贴文本；旁白 TTS 与 .epub 输入不可用。其余路线（DOCX/XLSX/PPTX/URL/MD/主题、模板、编辑原生 PPTX）可用。
6. **宿主权限提示**：本管线需要 Bash 权限。会话权限为 ask 模式时，先提示用户切换到 accept-edits/auto，避免逐步授权打断管线（历史失败主因之一）。**子代理不可用插件工具与技能——整个管线必须在主会话执行**，不要尝试派生子代理。
7. **跨会话续跑**：用户在新会话说"继续生成 projects/<name>"时：先 `ppt_master_status` 取路径，再 `ppt_read_doc` 读 `workflows/stages/resume-execute.md`，以项目目录文件（design_spec/spec_lock/svg_output）恢复进度，不依赖会话记忆。

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
