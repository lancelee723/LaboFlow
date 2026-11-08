// PPT workbench — the stage confirmation hero (Workbench-v2 T5–T8).
// The Stage-1 editable contract form, the Stage-2 direction cards +
// production params, the pure override builders, submitConfirm and the 2s
// pollHero. The rest of the page's state/wiring lives in workbench.js, which
// loads after this module — cross-references (loadProject, refreshProjects,
// renderStatusLine) only run at call time. Split out of workbench.js
// verbatim (Workbench-v2 T12).

// ───────────── Stage confirmation hero (replaces the popup confirm card) ────
// The agent submits Stage-1/Stage-2 recommendations; the pending decision is
// rendered in #hero above the preview (design §6: the decision is the dominant
// zone while it exists). Polling is the transport because an openPanel on a
// docked view is not a thing — and a poll also survives the panel being closed
// and reopened. Visibility keys off the same `pending` signal the poll already
// computes (in-memory pendingConfirm or a `status === "submitted"` stage
// recovered from disk by ppt.getBootstrap).

document.getElementById("t-native-charts").textContent = t.nativeCharts;
document.getElementById("t-confirm-section").textContent = t.confirmSection;
document.getElementById("btn-confirm-stage").textContent = t.confirm;
// Workbench-v2 T11: the waive affordance is promoted to a co-primary
// 「快速模式」 button — the underlying contract is unchanged (click reveals
// the reason input when empty, then submitConfirm(true) sends the
// waive+waiveReason payload); only the surface copy became Quick-profile.
document.getElementById("btn-waive-stage").textContent = t.quickMode;
document.getElementById("quick-mode-hint").textContent = t.quickModeHint;
document.getElementById("confirm-reason").placeholder = t.quickReason;

let renderedConfirmKey = null;
let confirmBusy = false;
let selectedDirection = 0;
let stage2Recs = null; // the stage-2 recommendations as rendered — the base buildStage2Overrides diffs against

function kvLines(obj) {
  if (obj === null || obj === undefined) return "";
  if (typeof obj !== "object") {
    return `<div class="keyline"><span class="k"></span><span>${esc(obj)}</span></div>`;
  }
  if (Array.isArray(obj)) {
    return obj
      .map((item, i) => {
        const label = item && typeof item === "object" && !Array.isArray(item)
          ? esc(item.name ?? item.title ?? item.label ?? `#${i + 1}`)
          : `#${i + 1}`;
        const inner = item && typeof item === "object" && !Array.isArray(item)
          ? kvLines(item)
          : `<div class="keyline"><span class="k"></span><span>${esc(item)}</span></div>`;
        return `<div class="confirm-subcard"><b>${label}</b>${inner}</div>`;
      })
      .join("");
  }
  return Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => {
      if (typeof v === "object") {
        const keys = Object.keys(v);
        if (keys.length === 1 && (keys[0] === "value" || keys[0] === "text") && typeof v[keys[0]] !== "object") {
          return `<div class="keyline"><span class="k">${esc(k)}</span><span>${esc(v[keys[0]])}</span></div>`;
        }
        return `<div class="confirm-subcard"><b>${esc(k)}</b>${kvLines(v)}</div>`;
      }
      return `<div class="keyline"><span class="k">${esc(k)}</span><span>${esc(v)}</span></div>`;
    })
    .join("");
}

function showConfirmError(message) {
  const box = document.getElementById("confirm-error");
  box.textContent = message;
  box.classList.remove("hidden");
}

// ───────────── Stage-1 editable form (Workbench-v2 T6) ─────────────
// The upstream Stage-1 surface is an EDITABLE form: every prose field starts
// seeded with the recommendation value; the user retains, revises or clears
// it — blank is the authoritative "no constraint" (confirm-surface.md §4).
// Rendering stamps each control with data-base = the seeded recommendation
// value, so buildStage1Overrides — a PURE function over the live form — can
// diff the user's edits against the recommendation and return ONLY the
// changed keys ({} when everything was kept). Canvas is enumerable
// (ppt169/ppt43) with a custom free-text fallback; an absent recommendation
// canvas seeds the default ppt169 (keeping the default then sends no
// override). template_mode defaults to free_design; with an embedded
// template_options the templates radio expands the T8 candidate checklist
// (selection rides the templateSelection channel field, not overrides).

/** Upstream `{ value }` wrapper → plain value; loose scalars pass through. */
function unwrapRecValue(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v.value : v;
}

// ───────────── Template-mode candidate selection (Workbench-v2 T8) ─────────────
// The stage-1 submission may embed `template_options`; when it does, the
// templates radio expands a checkbox list of candidates (multi-select, ≥1
// required upstream). The expected MVP shape is
// {candidates?: [{id, kind?, name?, note?, preselected?}], supplied_roots?:
// [...]} — unknown extras are ignored, and the richer upstream server catalog
// (confirm_ui.md: library{brand,style,layout,deck} + explicit +
// preselected_keys) degrades into the same flat list. When template_options is
// absent the templates radio keeps the placeholder hint; submitting templates
// mode with an empty selection is then rejected by the state machine with the
// authoritative message. The selected ids ride the panel channel
// (templateSelection) into template_selection.json — never into result.json.

/**
 * Defensive normalization of `template_options` into a flat candidate list
 * [{id, kind, name, note, preselected}]. Non-object input (field absent or
 * junk) yields []. Pure.
 */
function templateCandidates(options) {
  const o = options && typeof options === "object" && !Array.isArray(options) ? options : null;
  if (!o) return [];
  const preKeys = Array.isArray(o.preselected_keys) ? o.preselected_keys.map((k) => String(k)) : [];
  const out = [];
  const seen = new Set();
  const push = (raw, fallbackKind) => {
    const c = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
    if (!c) return;
    const id = String(c.id ?? c.key ?? c.workspace_root ?? c.path ?? "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    const name = String(c.name ?? c.label ?? id).trim() || id;
    const note = String(c.note ?? c.summary ?? "");
    const kind = String(c.kind ?? (fallbackKind ?? "")).trim();
    out.push({ id, kind, name, note, preselected: c.preselected === true || preKeys.includes(id) });
  };
  for (const cand of Array.isArray(o.candidates) ? o.candidates : []) push(cand);
  const library = o.library && typeof o.library === "object" && !Array.isArray(o.library) ? o.library : null;
  if (library) {
    for (const [kind, bucket] of Object.entries(library)) {
      for (const cand of Array.isArray(bucket) ? bucket : []) push(cand, kind);
    }
  }
  for (const cand of Array.isArray(o.explicit) ? o.explicit : []) push(cand, "root");
  for (const root of Array.isArray(o.supplied_roots) ? o.supplied_roots : []) {
    if (root && typeof root === "object") push(root, "root");
    else {
      const p = String(root ?? "").trim();
      if (p) push({ id: p, name: p.split(/[\\/]/).filter(Boolean).pop() || p, note: p }, "root");
    }
  }
  // Upstream convenience (confirm_ui.md): a single supplied exact root seeds
  // its candidate as the editable default; several roots stay unselected.
  if (!out.some((c) => c.preselected) && Array.isArray(o.supplied_roots) && o.supplied_roots.length === 1) {
    const only = o.supplied_roots[0];
    const id = only && typeof only === "object"
      ? String(only.id ?? only.key ?? only.path ?? "").trim()
      : String(only ?? "").trim();
    const hit = out.find((c) => c.id === id);
    if (hit) hit.preselected = true;
  }
  return out;
}

/** One checkbox row: name + kind chip (+ preselect chip) + note line. */
function templateCandidateHtml(c) {
  return `<label class="tpl-candidate">` +
    `<input type="checkbox" name="template_root" value="${esc(c.id)}"${c.preselected ? " checked" : ""}>` +
    `<span class="tpl-name">${esc(c.name)}</span>` +
    (c.kind ? `<span class="chip">${esc(c.kind)}</span>` : "") +
    (c.preselected ? `<span class="chip">${esc(t.tplPreselected)}</span>` : "") +
    (c.note ? `<span class="tpl-note muted">${esc(c.note)}</span>` : "") +
    `</label>`;
}

function stage1FormHtml(rec) {
  const val = (k) => String(unwrapRecValue(rec?.[k]) ?? "");
  const prose = (name, rows) =>
    `<label class="f-field"><span class="f-label">${esc(t[`f_${name}`])} <span class="optional">· ${esc(t.optionalHint)}</span></span>` +
    `<textarea name="${name}" rows="${rows}" data-base="${esc(val(name))}">${esc(val(name))}</textarea></label>`;
  const canvasVal = String(unwrapRecValue(rec?.canvas) ?? rec?.recommend?.canvas ?? "");
  const canvasCustom = canvasVal !== "" && canvasVal !== "ppt169" && canvasVal !== "ppt43";
  const canvasSeed = canvasCustom ? canvasVal : (canvasVal || "ppt169");
  const mode = rec?.template_mode === "templates" ? "templates" : "free_design";
  const candidates = templateCandidates(rec?.template_options);
  // T8: candidates replace the placeholder hint — the checkbox list is only
  // visible while the templates radio is checked.
  const templateArea = candidates.length
    ? `<div class="f-label tpl-title">${esc(t.tplCandidates)}</div>` +
      `<div id="template-candidates"${mode === "templates" ? "" : ' class="hidden"'}>` +
      candidates.map(templateCandidateHtml).join("") +
      `</div>`
    : `<div id="templates-hint" class="muted${mode === "templates" ? "" : " hidden"}">${esc(t.templatesHint)}</div>`;
  return `<form id="hero-stage1-form" class="stage1-form">` +
    prose("audience", 2) +
    prose("communication_intent", 2) +
    prose("audience_outcome", 2) +
    prose("core_message", 2) +
    prose("delivery_context", 2) +
    prose("artifact_afterlife", 2) +
    prose("content_divergence", 2) +
    `<label class="f-field"><span class="f-label">${esc(t.f_language)}</span>` +
    `<input type="text" name="primary_language" data-base="${esc(val("primary_language"))}" value="${esc(val("primary_language"))}" placeholder="zh-CN"></label>` +
    `<label class="f-field"><span class="f-label">${esc(t.f_canvas)}</span>` +
    `<select name="canvas" data-base="${esc(canvasSeed)}">` +
    `<option value="ppt169"${canvasSeed === "ppt169" ? " selected" : ""}>16:9 (ppt169)</option>` +
    `<option value="ppt43"${canvasSeed === "ppt43" ? " selected" : ""}>4:3 (ppt43)</option>` +
    `<option value="custom"${canvasCustom ? " selected" : ""}>${esc(t.canvasCustom)}</option>` +
    `</select>` +
    `<input type="text" name="canvas_custom" class="${canvasCustom ? "" : "hidden"}" value="${esc(canvasVal)}" placeholder="A4 / 16:10 …"></label>` +
    `<fieldset class="f-field"><legend class="f-label">${esc(t.f_mode)}</legend><div class="radio-row">` +
    `<label><input type="radio" name="template_mode" value="free_design"${mode === "free_design" ? " checked" : ""}> ${esc(t.modeFree)}</label>` +
    `<label><input type="radio" name="template_mode" value="templates"${mode === "templates" ? " checked" : ""}> ${esc(t.modeTemplates)}</label>` +
    `</div>` +
    templateArea +
    // T12: esc() for uniformity — mode is constrained to free_design |
    // templates today, but the interpolation must not rely on that.
    `<input type="hidden" name="template_mode_base" value="${esc(mode)}"></fieldset>` +
    `</form>`;
}

/**
 * Pure: diff the live Stage-1 form against the recommendation values it was
 * seeded with (data-base / template_mode_base). Returns ONLY the changed
 * keys — {} when the user kept every recommendation — so confirmStage's
 * whitelist merge (STAGE_OVERRIDE_FIELDS.stage1 in ppt-state.js) sees a
 * minimal payload. Prose values pass through verbatim, including "".
 * Self-contained on purpose: the tests extract this function by regex and
 * run it against fake forms, like deriveTimeline.
 */
function buildStage1Overrides(form) {
  const prose = ["audience", "communication_intent", "audience_outcome", "core_message",
    "delivery_context", "artifact_afterlife", "content_divergence", "primary_language"];
  const el = (name) => form?.elements?.[name];
  const overrides = {};
  for (const name of prose) {
    const node = el(name);
    if (!node) continue;
    const cur = String(node.value ?? "");
    if (cur !== String(node.dataset?.base ?? "")) overrides[name] = cur;
  }
  const sel = el("canvas");
  if (sel) {
    const cur = sel.value === "custom" ? String(el("canvas_custom")?.value ?? "") : String(sel.value ?? "");
    if (cur !== String(sel.dataset?.base ?? "")) overrides.canvas = cur;
  }
  const mode = el("template_mode");
  const modeBase = el("template_mode_base");
  if (mode && modeBase) {
    const cur = String(mode.value ?? "");
    if (cur !== String(modeBase.value ?? "")) overrides.template_mode = cur;
  }
  return overrides;
}

/**
 * Workbench-v2 T8: the live Stage-1 form → the selected template root ids.
 * [] unless the templates radio is checked — free design always resolves to
 * an empty selection no matter what stale checkbox state exists. Works on the
 * real DOM (form.elements returns the shared-name checkboxes as a collection)
 * and on the fake {elements} forms the tests build; a lone checkbox comes
 * back as a single node, so it is wrapped. Pure.
 */
function readTemplateSelection(form) {
  const el = (name) => form?.elements?.[name];
  if (String(el("template_mode")?.value ?? "") !== "templates") return [];
  const boxes = el("template_root");
  const list = boxes == null ? [] : typeof boxes.length === "number" ? boxes : [boxes];
  const roots = [];
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    if (node?.checked === true) roots.push(String(node.value ?? ""));
  }
  return roots;
}

/** Busy/freeze switch: disable (or release) every control of the Stage-1 form. */
function setStage1FormDisabled(disabled) {
  const form = document.getElementById("hero-stage1-form");
  if (!form) return;
  for (const node of form.querySelectorAll("button, input, select, textarea")) {
    node.disabled = disabled;
  }
}

function selectDirection(index) {
  selectedDirection = index;
  for (const card of document.querySelectorAll("#hero-stage2 .direction-card")) {
    card.classList.toggle("selected", Number(card.dataset.direction) === index);
  }
}

function hideHero() {
  renderedConfirmKey = null;
  stage2Recs = null;
  document.getElementById("hero").classList.add("hidden");
  document.getElementById("confirm-status").classList.add("hidden");
  // Release the frozen action buttons and waive reason (a frozen Stage-1
  // form / params panel is discarded by the next render — the DOM nodes go
  // away with innerHTML).
  document.getElementById("btn-confirm-stage").disabled = false;
  document.getElementById("btn-waive-stage").disabled = false;
  document.getElementById("confirm-reason").disabled = false;
}

// ───────────── Stage-2 direction cards + production params (Workbench-v2 T7) ─────────────
// The upstream candidate (vendored confirm-surface.md §3) is a COMPLETE
// design bundle: name/note, six-role color palette, typography, image
// strategy, and the mode/visual_style behaviors. Cards render all of it.
// Clicking a card only SELECTS it — the production parameters below the
// cards must be settable first, so the bottom confirm button is the single
// confirm path (the old one-shot click-confirm is gone deliberately).

function swatchStripHtml(color) {
  // The six upstream palette roles, in confirm-surface.md §3 order. Palette
  // values are agent-authored DATA, not styles: only a strict hex literal may
  // reach an inline background style — anything else renders a grey
  // placeholder block plus the raw text, never a style.
  const roles = ["primary", "accent", "secondary_accent", "background", "secondary_bg", "body_text"];
  const hexRe = /^#[0-9a-fA-F]{3,8}$/;
  const palette = color && typeof color === "object" && !Array.isArray(color)
    && color.palette && typeof color.palette === "object" && !Array.isArray(color.palette)
    ? color.palette
    : null;
  if (!palette) return "";
  const strip = roles.map((role) => {
    const raw = String(palette[role] ?? "");
    if (hexRe.test(raw)) {
      return `<span class="swatch" title="${esc(raw)}"><i style="background:${esc(raw)}"></i><small>${role}</small></span>`;
    }
    return `<span class="swatch swatch-bad" title="${esc(raw)}"><i></i><small>${role}</small>` +
      (raw ? `<code>${esc(raw)}</code>` : "") + `</span>`;
  }).join("");
  const label = typeof color.name === "string" && color.name.trim()
    ? `<span class="d-color-name">${esc(color.name)}</span>`
    : "";
  return `<div class="d-palette">${label}<span class="swatch-strip">${strip}</span></div>`;
}

function typographyLineHtml(typography) {
  if (!typography || typeof typography !== "object" || Array.isArray(typography)) return "";
  const font = (role) => {
    const f = typography[role];
    if (!f || typeof f !== "object" || Array.isArray(f)) return "";
    const primary = String(f.primary ?? "").trim();
    if (!primary) return "";
    const english = String(f.english ?? "").trim();
    return english ? `${primary} / ${english}` : primary;
  };
  const parts = [];
  const heading = font("heading");
  if (heading) parts.push(esc(heading));
  const body = font("body");
  if (body && body !== heading) parts.push(esc(body));
  const size = Number(typography.body_size);
  if (Number.isFinite(size) && size > 0) parts.push(`${esc(t.f_body_size)} ${size}pt`);
  return parts.length ? `<div class="d-typography">${parts.join(" · ")}</div>` : "";
}

function strategyBlockHtml(strategy) {
  if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) return "";
  const line = (label, v) => {
    const text = String(v ?? "").trim();
    return text ? `<div class="keyline"><span class="k">${label}</span><span>${esc(text)}</span></div>` : "";
  };
  const name = String(strategy.name ?? "").trim();
  const lines = line("visual", strategy.visual) + line("mood", strategy.mood) + line("behavior", strategy.behavior);
  if (!name && !lines) return "";
  return `<div class="d-strategy">${name ? `<b>${esc(name)}</b>` : ""}${lines}</div>`;
}

function behaviorDetailsHtml(dir) {
  const rows = [
    ["mode", dir.mode_behavior],
    ["visual_style", dir.visual_style_behavior],
  ].filter(([, v]) => typeof v === "string" && v.trim());
  if (!rows.length) return "";
  return `<details class="d-behaviors"><summary>${esc(t.behaviorDetails)}</summary>` +
    rows.map(([k, v]) => `<div class="keyline"><span class="k">${k}</span><span>${esc(v)}</span></div>`).join("") +
    `</details>`;
}

function directionCard(d, i) {
  const dir = d && typeof d === "object" && !Array.isArray(d) ? d : null;
  const name = dir ? dir.name ?? dir.title ?? `#${i + 1}` : `#${i + 1}`;
  const note = dir ? String(dir.note ?? dir.summary ?? dir.description ?? "") : "";
  const head = `<b>${esc(i === 0 ? `★ ${name}` : name)}</b>` +
    (note ? `<div class="d-summary">${esc(note)}</div>` : "");
  const open = `<div class="direction-card${i === selectedDirection ? " selected" : ""}" data-direction="${i}" role="button" tabindex="0">`;
  if (!dir) return `${open}${head}${kvLines(d)}</div>`; // odd candidate: degrade to the keyline dump
  return `${open}${head}${swatchStripHtml(dir.color)}${typographyLineHtml(dir.typography)}` +
    `${strategyBlockHtml(dir.image_strategy)}${behaviorDetailsHtml(dir)}</div>`;
}

/**
 * Stage-2 recommendation → seed values for the production-params panel.
 * Absent fields resolve to the documented upstream defaults (confirm-surface
 * §4, mirrored by the T5 assembly): the proactive trio true/false/false,
 * refine_spec false, generation_mode "continuous", design_spec_depth
 * "complete"; page_count and image_notes seed to "" when the submission
 * omits them. Values unwrap the upstream `{ value }` wrapper. Pure.
 */
function stage2ParamSeeds(recs) {
  const r = recs && typeof recs === "object" && !Array.isArray(recs) ? recs : {};
  const recommend = r.recommend && typeof r.recommend === "object" && !Array.isArray(r.recommend) ? r.recommend : {};
  const bool = (v, dflt) => (typeof v === "boolean" ? v : dflt);
  const text = (v) => (v === undefined || v === null ? "" : String(v));
  const mode = text(unwrapRecValue(r.generation_mode) ?? unwrapRecValue(recommend.generation_mode));
  const depth = text(unwrapRecValue(r.design_spec_depth));
  return {
    page_count: text(unwrapRecValue(r.page_count)),
    proactive_speaker_notes: bool(unwrapRecValue(r.proactive_speaker_notes), true),
    proactive_custom_animations: bool(unwrapRecValue(r.proactive_custom_animations), false),
    proactive_narration_audio: bool(unwrapRecValue(r.proactive_narration_audio), false),
    generation_mode: mode === "split" ? "split" : "continuous",
    design_spec_depth: depth === "brief" ? "brief" : "complete",
    refine_spec: bool(unwrapRecValue(r.refine_spec), false),
    image_notes: text(unwrapRecValue(r.image_notes)),
  };
}

/** The production-params panel — independent of the selected direction. */
function stage2ParamsHtml(rec) {
  const seeds = stage2ParamSeeds(rec);
  const check = (name) =>
    `<label class="param-check"><input type="checkbox" name="${name}" data-base="${seeds[name]}"${seeds[name] ? " checked" : ""}> ${esc(t[`f_${name}`])}</label>`;
  const select = (name, options) =>
    `<label class="f-field"><span>${esc(t[`f_${name}`])}</span>` +
    `<select name="${name}" data-base="${esc(seeds[name])}">` +
    options.map(([v, label]) => `<option value="${v}"${seeds[name] === v ? " selected" : ""}>${esc(label)} (${v})</option>`).join("") +
    `</select></label>`;
  return `<form id="hero-stage2-params" class="stage2-params">` +
    `<span class="f-label">${esc(t.paramsTitle)}</span>` +
    `<div class="param-row">${check("proactive_speaker_notes")}${check("proactive_custom_animations")}${check("proactive_narration_audio")}</div>` +
    `<div class="param-row">` +
    `<label class="f-field"><span>${esc(t.f_page_count)}</span>` +
    `<input type="text" name="page_count" data-base="${esc(seeds.page_count)}" value="${esc(seeds.page_count)}"></label>` +
    select("generation_mode", [["continuous", t.genContinuous], ["split", t.genSplit]]) +
    select("design_spec_depth", [["brief", t.specBrief], ["complete", t.specComplete]]) +
    check("refine_spec") +
    `</div>` +
    `<label class="f-field param-notes"><span>${esc(t.f_image_notes)}</span>` +
    `<textarea name="image_notes" rows="2" data-base="${esc(seeds.image_notes)}">${esc(seeds.image_notes)}</textarea></label>` +
    `</form>`;
}

/** Live production-params panel → plain values for buildStage2Overrides. */
function readStage2Params() {
  const form = document.getElementById("hero-stage2-params");
  if (!form) return null;
  const el = (name) => form.elements[name];
  return {
    page_count: String(el("page_count")?.value ?? ""),
    proactive_speaker_notes: el("proactive_speaker_notes")?.checked === true,
    proactive_custom_animations: el("proactive_custom_animations")?.checked === true,
    proactive_narration_audio: el("proactive_narration_audio")?.checked === true,
    generation_mode: String(el("generation_mode")?.value ?? ""),
    design_spec_depth: String(el("design_spec_depth")?.value ?? ""),
    refine_spec: el("refine_spec")?.checked === true,
    image_notes: String(el("image_notes")?.value ?? ""),
  };
}

/**
 * Pure: diff the user's Stage-2 decision against the recommendation it was
 * rendered from — the selected direction index plus the production params
 * (seeded by stage2ParamSeeds). Returns ONLY the changed keys — {} when the
 * user kept every seed — so confirmStage's whitelist merge
 * (STAGE_OVERRIDE_FIELDS.stage2 in ppt-state.js) sees a minimal payload.
 * Booleans go over as real booleans and selected as a safe integer, exactly
 * what coerceOverrideValue accepts; page_count / generation_mode /
 * design_spec_depth / image_notes pass through verbatim (including "").
 * The recommendation's default direction follows the same resolution as
 * selectedDirectionRef in ppt-state.js (design_directions.selected, then
 * top-level selected, then 0). Self-contained with stage2ParamSeeds on
 * purpose: the tests extract and run them like deriveTimeline.
 */
function buildStage2Overrides(selected, params, recs) {
  const seeds = stage2ParamSeeds(recs);
  const dd = recs && typeof recs === "object" && !Array.isArray(recs) ? recs.design_directions : null;
  const ddObj = dd && typeof dd === "object" && !Array.isArray(dd) ? dd : null;
  const seedSelected = Number.isSafeInteger(ddObj?.selected) ? ddObj.selected
    : Number.isSafeInteger(recs?.selected) ? recs.selected
    : 0;
  const p = params && typeof params === "object" ? params : {};
  const overrides = {};
  if (Number.isSafeInteger(selected) && selected !== seedSelected) overrides.selected = selected;
  for (const key of ["proactive_speaker_notes", "proactive_custom_animations", "proactive_narration_audio", "refine_spec"]) {
    if (typeof p[key] === "boolean" && p[key] !== seeds[key]) overrides[key] = p[key];
  }
  for (const key of ["page_count", "generation_mode", "design_spec_depth", "image_notes"]) {
    if (typeof p[key] === "string" && p[key] !== seeds[key]) overrides[key] = p[key];
  }
  return overrides;
}

/** Busy/freeze switch: disable (or release) every control of the params panel. */
function setStage2ParamsDisabled(disabled) {
  const form = document.getElementById("hero-stage2-params");
  if (!form) return;
  for (const node of form.querySelectorAll("button, input, select, textarea")) {
    node.disabled = disabled;
  }
}

async function submitConfirm(waive) {
  if (confirmBusy || !renderedConfirmKey) return;
  const reasonInput = document.getElementById("confirm-reason");
  const reason = reasonInput.value.trim();
  if (waive && !reason) {
    showConfirmError(t.needReason);
    reasonInput.classList.remove("hidden");
    return;
  }
  const [projectDir, stage] = renderedConfirmKey.split("::");
  // Workbench-v2 T8: read the template candidate selection while the form is
  // still live (stage-1, non-waive only). A visible candidate list with zero
  // checked roots is refused locally — the confirm stays disabled until the
  // user picks at least one. With NO candidate UI (template_options absent)
  // the submit goes through and the state machine rejects templates mode with
  // the authoritative error message.
  const stage1Form = document.getElementById("hero-stage1-form");
  const templateSelection = !waive && stage === "stage1" && stage1Form
    ? readTemplateSelection(stage1Form)
    : undefined;
  const candidateBox = document.getElementById("template-candidates");
  if (candidateBox && !candidateBox.classList.contains("hidden") && templateSelection?.length === 0) {
    showConfirmError(t.tplNeedOne);
    return;
  }
  confirmBusy = true;
  const btnConfirm = document.getElementById("btn-confirm-stage");
  const btnWaive = document.getElementById("btn-waive-stage");
  btnConfirm.disabled = true;
  btnWaive.disabled = true;
  // Workbench-v2 T6/T7: busy disables the WHOLE decision area, not just the
  // action buttons — the Stage-1 form, the Stage-2 params panel, and the
  // waive reason (part of the frozen area since T7) may not dangle editable
  // under a pending confirm.
  setStage1FormDisabled(true);
  setStage2ParamsDisabled(true);
  reasonInput.disabled = true;
  document.getElementById("confirm-error").classList.add("hidden");
  // T6/T7: a non-waive confirm sends the user's edits as overrides ({} =
  // kept every recommendation); waive ignores overrides server-side, so it
  // never sends any. Stage-1 diffs the editable form; stage-2 diffs the
  // selected direction plus the production-params panel against the
  // recommendations as rendered. T8: the template root selection rides its
  // own channel field — never through the overrides whitelist.
  const stage2Params = stage === "stage2" && !waive ? readStage2Params() : null;
  const overrides = !waive && stage === "stage1" && stage1Form
    ? buildStage1Overrides(stage1Form)
    : stage2Params
      ? buildStage2Overrides(selectedDirection, stage2Params, stage2Recs)
      : undefined;
  let decided = false;
  try {
    const result = await bridge.invoke("ppt.confirmStage", {
      projectDir, stage, waive, waiveReason: reason || null, overrides, templateSelection,
    });
    // F-5: the bridge can settle undefined (e.g. the host's gone-surface
    // tail-of-teardown path). Anything short of an explicit ok is a failure —
    // a silent undefined once rendered a fake "confirmed" while the state
    // machine never moved, leaving the gate stuck at "submitted".
    if (result && result.error) {
      showConfirmError(String(result.error));
    } else if (!result || result.ok !== true) {
      showConfirmError(t.confirmFailed);
    } else {
      decided = true;
      const status = document.getElementById("confirm-status");
      status.textContent = t.confirmed;
      status.classList.remove("hidden");
      document.getElementById("confirm-reason").classList.add("hidden");
      // The pipeline listing may now show the newly confirmed gate; reload
      // the project the decision belonged to (local const shadows the outer
      // selection — that is exactly the confirmed project).
      void loadProject(projectDir);
      setTimeout(() => { hideHero(); }, 4000);
    }
  } catch (error) {
    showConfirmError(String(error?.message ?? error));
  } finally {
    confirmBusy = false;
    // A decided gate freezes AS SUBMITTED (form + buttons stay disabled)
    // until hideHero clears it, so the user keeps seeing what they sent.
    // Any other outcome (error, retry-able failure) re-enables everything.
    if (!decided) {
      btnConfirm.disabled = false;
      btnWaive.disabled = false;
      setStage1FormDisabled(false);
      setStage2ParamsDisabled(false);
      reasonInput.disabled = false;
    }
  }
}

async function pollHero() {
  if (confirmBusy) return;
  let boot;
  try {
    boot = await bridge.invoke("ppt.getBootstrap");
  } catch {
    return; // bridge busy; the next tick retries
  }
  const pending = boot?.pending ?? null;
  const prevPendingDir = pendingConfirmDir;
  pendingConfirmDir = pending?.projectDir ?? "";
  // 遗留 B: refresh the preview-exit signal the status line reports (cheap
  // Map read on the plugin side). Best-effort: a busy bridge keeps the last
  // status, and an unloaded project clears it.
  if (projectDir) {
    try {
      previewStatus = (await bridge.invoke("ppt.getPreviewStatus", { projectDir }))?.preview ?? previewStatus;
    } catch { /* keep the previous status */ }
  } else {
    previewStatus = null;
  }
  // The hero's pending signal is also the status line's await-confirm state;
  // refresh it here (2s) so a surfaced/cleared decision flips the line fast.
  renderStatusLine();
  // A newly surfaced pending decision for another project re-points the
  // selector at once instead of waiting for the 10s listing poll.
  if (pendingConfirmDir && pendingConfirmDir !== prevPendingDir && pendingConfirmDir !== projectDir) {
    void refreshProjects();
  }
  const key = pending ? `${pending.projectDir}::${pending.stage}` : null;
  if (key === renderedConfirmKey) return;
  renderedConfirmKey = key;
  const hero = document.getElementById("hero");
  const box1 = document.getElementById("hero-stage1");
  const box2 = document.getElementById("hero-stage2");
  document.getElementById("confirm-status").classList.add("hidden");
  if (!pending) {
    hero.classList.add("hidden");
    box1.classList.add("hidden");
    box2.classList.add("hidden");
    return;
  }
  hero.classList.remove("hidden");
  selectedDirection = 0;
  stage2Recs = null;
  // A fresh pending render must start fully interactive: a decided freeze
  // from a PREVIOUS gate can still be inside its 4s visibility window when
  // the next gate's decision surfaces. (The 2s poll re-renders only when
  // this pending KEY is new, so the user's in-progress edits are safe.)
  document.getElementById("btn-confirm-stage").disabled = false;
  document.getElementById("btn-waive-stage").disabled = false;
  document.getElementById("confirm-reason").disabled = false;
  document.getElementById("confirm-reason").classList.add("hidden");
  document.getElementById("confirm-error").classList.add("hidden");
  box1.classList.toggle("hidden", pending.stage !== "stage1");
  box2.classList.toggle("hidden", pending.stage !== "stage2");
  const active = pending.stage === "stage1" ? box1 : box2;
  const head = `<div class="confirm-stage-head">${esc(pending.stage === "stage1" ? t.stage1 : t.stage2)}</div>` +
    `<div class="muted">${esc(pending.projectDir)}</div>`;
  try {
    const data = await bridge.invoke("ppt.getState", { projectDir: pending.projectDir });
    const rec = data?.recommendations?.[pending.stage];
    if (rec && pending.stage === "stage2") {
      stage2Recs = rec;
      // Same pool resolution as selectedDirectionRef in ppt-state.js — the
      // card indexes must line up with the `selected` override the state
      // machine applies to the submission.
      const dd = rec.design_directions;
      const directions = dd && typeof dd === "object" && !Array.isArray(dd) && Array.isArray(dd.candidates) && dd.candidates.length
        ? dd.candidates
        : Array.isArray(rec.directions) && rec.directions.length ? rec.directions
        : Array.isArray(rec.options) && rec.options.length ? rec.options
        : [];
      active.innerHTML = head +
        `<div class="muted">${esc(t.pickHint)}</div>` +
        directions.map((d, i) => directionCard(d, i)).join("") +
        stage2ParamsHtml(rec) +
        `<details><summary class="muted">raw</summary><pre>${esc(JSON.stringify(rec, null, 2))}</pre></details>`;
    } else if (rec && pending.stage === "stage1") {
      // Workbench-v2 T6: the contract renders as an EDITABLE form seeded
      // with the recommendation values (kv rendering remains the fallback
      // shape below).
      active.innerHTML = head + stage1FormHtml(rec) +
        `<details><summary class="muted">raw</summary><pre>${esc(JSON.stringify(rec, null, 2))}</pre></details>`;
    } else if (rec) {
      active.innerHTML = head + `<div>${kvLines(rec)}</div>` +
        `<details><summary class="muted">raw</summary><pre>${esc(JSON.stringify(rec, null, 2))}</pre></details>`;
    } else {
      active.innerHTML = head + `<pre>${esc(JSON.stringify(pending, null, 2))}</pre>`;
    }
  } catch {
    active.innerHTML = head + `<pre>${esc(JSON.stringify(pending, null, 2))}</pre>`;
  }
}

document.getElementById("btn-confirm-stage").addEventListener("click", () => submitConfirm(false));
document.getElementById("btn-waive-stage").addEventListener("click", () => submitConfirm(true));
// Stage-2 direction cards (Workbench-v2 T7): clicking a card only SELECTS
// that direction — production params must be settable before confirming, so
// the bottom confirm button is the single confirm path (the one-shot
// click-confirm is deliberately gone). The star-marked recommended card
// starts selected; keyboard Enter/Space selects like a click.
const heroStage2 = document.getElementById("hero-stage2");
heroStage2.addEventListener("click", (event) => {
  const card = event.target.closest("[data-direction]");
  if (!card) return;
  selectDirection(Number(card.dataset.direction));
});
heroStage2.addEventListener("keydown", (event) => {
  if (event.target.classList?.contains("direction-card") && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    event.target.click();
  }
});
// Stage-1 form delegated events (Workbench-v2 T6): pollHero re-renders the
// form on every pass, so listeners hang off the static #hero-stage1
// container instead of the transient <form>.
const heroStage1 = document.getElementById("hero-stage1");
heroStage1.addEventListener("submit", (event) => event.preventDefault());
heroStage1.addEventListener("change", (event) => {
  const form = event.target.closest("form");
  if (!form) return;
  if (event.target?.name === "canvas") {
    form.elements.canvas_custom.classList.toggle("hidden", event.target.value !== "custom");
  }
  if (event.target?.name === "template_mode") {
    // Workbench-v2 T8: the candidate checklist (or, absent template_options,
    // the placeholder hint) is only visible under the templates radio. Free
    // design clears every selection, mirroring the upstream page.
    const templates = event.target.value === "templates";
    document.getElementById("templates-hint")?.classList.toggle("hidden", !templates);
    document.getElementById("template-candidates")?.classList.toggle("hidden", !templates);
    if (!templates) {
      for (const node of form.querySelectorAll('input[name="template_root"]')) node.checked = false;
    }
  }
});
