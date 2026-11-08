/**
 * PPT-Master stage confirmation state machine (module 06 L2, DEVPLAN Phase B).
 *
 * Replaces the upstream Flask confirm surface while preserving its file
 * protocol byte-for-byte: the agent writes recommendations.stage{1,2}.json,
 * the USER (via panel/命令面板) is the only writer of result.json and
 * template_selection.json, and export-class scripts refuse to run until
 * stage2 is confirmed (or explicitly waived with a reason). State lives in
 * <project>/laboflow/pipeline-state.json; nothing depends on session memory.
 *
 * The "read once" upstream rule for result.json is enforced here: the first
 * agent read marks it; later reads return the cached summary with a warning.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath, sep as pathSep } from "node:path";

export const STAGES = ["stage1", "stage2"];
const STATE_VERSION = 1;

export function statePath(projectDir) {
  return join(projectDir, "laboflow", "pipeline-state.json");
}

export function freshState(project) {
  return {
    version: STATE_VERSION,
    project: project ?? null,
    stages: {
      stage1: { status: "pending" },
      stage2: { status: "pending" },
      spec_gate1: { status: "pending" },
      spec_gate2: { status: "pending" },
    },
  };
}

export function loadState(projectDir) {
  const path = statePath(projectDir);
  if (!existsSync(path)) return { state: freshState(null), created: true, corrupted: false };
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (!state?.stages?.stage1 || !state?.stages?.stage2) throw new Error("missing stages");
    return { state, created: false, corrupted: false };
  } catch {
    // Corrupt / hand-edited: quarantine and fall back to pending — the user
    // simply re-confirms. Never guess a confirmed state.
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
    return { state: freshState(null), created: true, corrupted: true };
  }
}

export function saveState(projectDir, state) {
  const path = statePath(projectDir);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
  return state;
}

/**
 * Resolve the selected-design-direction reference from a stage-2 submission.
 * Canonical upstream keeps `design_directions: { selected, candidates }`; the
 * plugin's loose shape carries a top-level `directions`/`options` array with a
 * top-level `selected` (Workbench-v2 T4 ledger ruling: read BOTH
 * `design_directions.selected` and `selected`). Returns null when the
 * submission has no direction pool at all (e.g. quick mode).
 */
function selectedDirectionRef(recs) {
  const dd = recs.design_directions;
  const ddObj = dd && typeof dd === "object" && !Array.isArray(dd) ? dd : null;
  const pool = ddObj && Array.isArray(ddObj.candidates) && ddObj.candidates.length > 0
    ? ddObj.candidates
    : Array.isArray(recs.directions) && recs.directions.length > 0
      ? recs.directions
      : Array.isArray(recs.options) && recs.options.length > 0
        ? recs.options
        : null;
  if (!pool) return null;
  return { pool, index: ddObj?.selected ?? recs.selected };
}

/** Loose upstream-shape validation; the strategist corpus owns the full contract. */
export function validateRecommendations(stage, recommendations) {
  if (!recommendations || typeof recommendations !== "object" || Array.isArray(recommendations)) {
    return "recommendations 必须是对象";
  }
  if (stage === "stage2") {
    const directions = recommendations.directions ?? recommendations.options;
    if (recommendations.quick !== true && (!Array.isArray(directions) || directions.length === 0)) {
      return "stage2 recommendations 需要 directions 数组（三个设计方向）";
    }
    // Production params (page_count, image_usage, image_notes, image_ai_path,
    // delivery_purpose, generation_mode, refine_spec, design_spec_depth,
    // proactive_*) pass through untouched — no strictness beyond the
    // directions requirement and the selected-index bounds (upstream
    // confirm_ui.md: explicit selected must be an integer inside the pool).
    const ref = selectedDirectionRef(recommendations);
    if (ref && ref.index !== undefined && ref.index !== null) {
      if (!Number.isSafeInteger(ref.index) || ref.index < 0 || ref.index >= ref.pool.length) {
        return "selected 超出方向范围";
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Workbench-v2 T4: user overrides merged into the confirmed result.
//
// Upstream rule (vendored/ppt-master/references/confirm-surface.md §4): once
// the user submits, the submitted strings — including "" — are authoritative
// and preserved through every later stage and the final result.json. The
// workbench forms therefore send edited fields as `overrides` and confirmStage
// replaces the recommendation values at their upstream result.json locations
// before writing. The file shape stays upstream-faithful (no extra wrapper
// key); the fact of editing is recorded in pipeline-state (stages.<s>.userEdited)
// and rejected keys are counted into stages.<s>.overrideDropped for diagnosis.
// ---------------------------------------------------------------------------

/**
 * The SINGLE whitelist of user-editable fields per stage. stage1 = the seven
 * prose fields + primary_language + canvas + template_mode; stage2 = the
 * production parameters + the selected design direction. T6/T7 build the
 * forms from this export; do not duplicate the list.
 */
export const STAGE_OVERRIDE_FIELDS = {
  stage1: [
    "audience",
    "communication_intent",
    "audience_outcome",
    "core_message",
    "delivery_context",
    "artifact_afterlife",
    "content_divergence",
    "primary_language",
    "canvas",
    "template_mode",
  ],
  stage2: [
    "page_count",
    "proactive_speaker_notes",
    "proactive_custom_animations",
    "proactive_narration_audio",
    "generation_mode",
    "design_spec_depth",
    "refine_spec",
    "image_notes",
    "selected",
  ],
};

// Where each whitelisted key lives in the submitted recommendations
// (references/confirm-surface.md §2/§3): "wrapper" = top-level `{ value }`
// object (prose and production params; scalar recommendations are replaced
// as-is); "plain" = top-level scalar; "recommend" = scalar under `recommend`;
// "directions" = the zero-based selected index.
const OVERRIDE_LAYOUT = {
  stage1: {
    audience: "wrapper",
    communication_intent: "wrapper",
    audience_outcome: "wrapper",
    core_message: "wrapper",
    delivery_context: "wrapper",
    artifact_afterlife: "wrapper",
    content_divergence: "wrapper",
    primary_language: "plain",
    canvas: "recommend",
    template_mode: "plain",
  },
  stage2: {
    page_count: "wrapper",
    proactive_speaker_notes: "wrapper",
    proactive_custom_animations: "wrapper",
    proactive_narration_audio: "wrapper",
    generation_mode: "recommend",
    design_spec_depth: "wrapper",
    refine_spec: "wrapper",
    image_notes: "wrapper",
    selected: "directions",
  },
};

// The form sends these as "true"/"false" strings; the selected direction is a
// zero-based integer. Everything else passes through verbatim (including "").
const BOOLEAN_OVERRIDE_KEYS = new Set([
  "proactive_speaker_notes",
  "proactive_custom_animations",
  "proactive_narration_audio",
  "refine_spec",
]);
const INTEGER_OVERRIDE_KEYS = new Set(["selected"]);

/** Coerce one form value to its result.json type; undefined when unusable. */
function coerceOverrideValue(key, raw) {
  if (BOOLEAN_OVERRIDE_KEYS.has(key)) {
    const v = typeof raw === "boolean" ? raw : typeof raw === "string" ? raw.trim().toLowerCase() : null;
    if (v === true || v === "true") return true;
    if (v === false || v === "false") return false;
    return undefined;
  }
  if (INTEGER_OVERRIDE_KEYS.has(key)) {
    const v = typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    return Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  }
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/** Replace one value in place, preserving the submitted assembly around it. */
function writeOverrideValue(recs, key, value, layout) {
  if (layout === "directions") {
    const dd = recs.design_directions;
    // Canonical upstream keeps selected inside the design_directions object;
    // the plugin's loose `directions` array has no such slot → record top-level.
    if (dd && typeof dd === "object" && !Array.isArray(dd)) dd.selected = value;
    else recs.selected = value;
    return;
  }
  let host = recs;
  if (layout === "recommend") {
    // A malformed submission must not crash the confirm on property assign.
    if (!recs.recommend || typeof recs.recommend !== "object" || Array.isArray(recs.recommend)) recs.recommend = {};
    host = recs.recommend;
  }
  const cur = host[key];
  if (cur && typeof cur === "object" && !Array.isArray(cur)) cur.value = value;
  else if ((cur === null || cur === undefined) && layout === "wrapper") host[key] = { value };
  else host[key] = value;
}

/**
 * Apply user overrides to a recommendations object (mutated in place — the
 * object is freshly parsed from the submission file). Returns applied/dropped
 * counts, or null when there is nothing to do so the legacy path stays
 * byte-identical. Non-whitelisted or unusable values are never written.
 */
export function applyUserOverrides(stage, recommendations, overrides) {
  const layout = OVERRIDE_LAYOUT[stage];
  if (!layout || !recommendations || typeof recommendations !== "object" || Array.isArray(recommendations)) return null;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return null;
  let applied = 0;
  let dropped = 0;
  for (const [key, raw] of Object.entries(overrides)) {
    if (!Object.hasOwn(layout, key)) {
      dropped += 1; // not user-editable — silently ignored, counted for diagnosis
      continue;
    }
    const value = coerceOverrideValue(key, raw);
    if (value === undefined) {
      dropped += 1;
      continue;
    }
    writeOverrideValue(recommendations, key, value, layout[key]);
    applied += 1;
  }
  return applied + dropped > 0 ? { applied, dropped } : null;
}

// ---------------------------------------------------------------------------
// Workbench-v2 T5: stage-2 confirm assembles the upstream FINAL payload.
//
// Upstream (vendored/ppt-master/references/confirm-surface.md §4 + scripts/
// docs/confirm_ui.md "Output — result.json"): the final result.json is a FLAT
// object — the selected design direction's fields and the production
// parameters sit at top level with their final types, not nested under a
// recommendations copy. Absent fields resolve to the documented upstream
// defaults: the proactive trio true/false/false, design_spec_depth "complete"
// (legacy-read rule), generation_mode "continuous", refine_spec false. Fields
// with no upstream default (page_count, image_notes, image_usage,
// delivery_purpose, image_ai_path, canvas, the direction components) appear
// only when the submission carries them. T4 user overrides are applied to the
// parsed submission BEFORE assembly, so an overridden value always wins over
// a recommendation value and over a default. Everything else in the
// submission (stage-1 prose fields folded by the authoring side, lang,
// template_application, ...) passes through verbatim.
// ---------------------------------------------------------------------------

/** Upstream `{ value }` wrapper → flat value; anything else passes through. */
function unwrapValueField(v) {
  return v && typeof v === "object" && !Array.isArray(v) && "value" in v ? v.value : v;
}

function firstDefined(...values) {
  for (const v of values) if (v !== undefined) return v;
  return undefined;
}

/** The selected direction's components, flattened to result.json top level. */
const DIRECTION_SURFACE_KEYS = [
  "mode",
  "mode_behavior",
  "visual_style",
  "visual_style_behavior",
  "color",
  "icons",
  "typography",
  "image_strategy",
];

// Keys restructured during assembly — each is surfaced in final form below
// (unwrapped / defaulted / flattened), never copied verbatim.
const ASSEMBLY_RESTRUCTURED_KEYS = new Set([
  "stage",
  "status",
  "recommend",
  "page_count",
  "image_notes",
  "refine_spec",
  "design_spec_depth",
  "proactive_speaker_notes",
  "proactive_custom_animations",
  "proactive_narration_audio",
  "directions",
  "options",
  "design_directions",
]);

function assembleFinalResult(recs) {
  const recommend = recs.recommend && typeof recs.recommend === "object" && !Array.isArray(recs.recommend)
    ? recs.recommend
    : {};
  const passthrough = {};
  for (const [key, value] of Object.entries(recs)) {
    if (!ASSEMBLY_RESTRUCTURED_KEYS.has(key)) passthrough[key] = value;
  }
  const ref = selectedDirectionRef(recs);
  const index = ref
    ? (Number.isSafeInteger(ref.index) && ref.index >= 0 && ref.index < ref.pool.length ? ref.index : 0)
    : null;
  const direction = ref && typeof ref.pool[index] === "object" && ref.pool[index] !== null ? ref.pool[index] : null;

  const result = { stage: "final", status: "confirmed", ...passthrough };

  const canvas = firstDefined(recs.canvas, recommend.canvas);
  if (canvas !== undefined && canvas !== null) result.canvas = canvas;
  const pageCount = unwrapValueField(recs.page_count);
  if (pageCount !== undefined && pageCount !== null) result.page_count = pageCount;
  const imageNotes = unwrapValueField(recs.image_notes);
  if (imageNotes !== undefined && imageNotes !== null) result.image_notes = imageNotes;
  const imageUsage = firstDefined(recs.image_usage, recommend.image_usage);
  if (imageUsage !== undefined && imageUsage !== null) result.image_usage = imageUsage;
  const deliveryPurpose = firstDefined(recs.delivery_purpose, recommend.delivery_purpose);
  if (deliveryPurpose !== undefined && deliveryPurpose !== null) result.delivery_purpose = deliveryPurpose;
  const imageAiPath = firstDefined(recs.image_ai_path, recommend.image_ai_path);
  if (imageAiPath !== undefined && imageAiPath !== null) result.image_ai_path = imageAiPath;
  const generationMode = firstDefined(recs.generation_mode, recommend.generation_mode);
  if (generationMode !== undefined && generationMode !== null) result.generation_mode = generationMode;
  else result.generation_mode = "continuous";
  const designSpecDepth = unwrapValueField(recs.design_spec_depth);
  if (designSpecDepth !== undefined && designSpecDepth !== null) result.design_spec_depth = designSpecDepth;
  else result.design_spec_depth = "complete";
  const refineSpec = unwrapValueField(recs.refine_spec);
  result.refine_spec = typeof refineSpec === "boolean" ? refineSpec : false;
  const speakerNotes = unwrapValueField(recs.proactive_speaker_notes);
  result.proactive_speaker_notes = typeof speakerNotes === "boolean" ? speakerNotes : true;
  const customAnimations = unwrapValueField(recs.proactive_custom_animations);
  result.proactive_custom_animations = typeof customAnimations === "boolean" ? customAnimations : false;
  const narrationAudio = unwrapValueField(recs.proactive_narration_audio);
  result.proactive_narration_audio = typeof narrationAudio === "boolean" ? narrationAudio : false;

  if (direction) {
    // Direction components win over same-named legacy top-level candidates;
    // absent components stay absent (the upstream page edits components, not
    // ids — the index records which bundle was applied).
    for (const key of DIRECTION_SURFACE_KEYS) {
      if (direction[key] !== undefined && direction[key] !== null) result[key] = direction[key];
    }
    result.selected = index;
  }
  return result;
}

/** Agent submits its recommendations for a stage → panel opens, user decides. */
export function submitStage(projectDir, stage, recommendations, now = () => new Date().toISOString(), estimate) {
  if (!STAGES.includes(stage)) return { error: `stage 必须是 ${STAGES.join(" | ")}` };
  const invalid = validateRecommendations(stage, recommendations);
  if (invalid) return { error: invalid };
  const { state, corrupted } = loadState(projectDir);
  const stageState = state.stages[stage];
  if (stageState.status === "confirmed" || stageState.status === "waived") {
    return { error: `${stage} 已确认，无需重复提交；如需改选请新建项目或请用户在 PPT 工作台「设计确认」区重新提交`, state };
  }
  if (estimate) stageState.estimate = estimate;
  const confirmDir = join(projectDir, "confirm_ui");
  mkdirSync(confirmDir, { recursive: true });
  // Upstream file protocol, verbatim names.
  writeFileSync(
    join(confirmDir, `recommendations.${stage}.json`),
    JSON.stringify(recommendations, null, 2),
  );
  stageState.status = "submitted";
  stageState.submittedAt = now();
  stageState.surface = "panel";
  if (corrupted) state.corruptedRecovered = true;
  saveState(projectDir, state);
  return { state, recommendationsPath: join(confirmDir, `recommendations.${stage}.json`) };
}

/**
 * USER confirms/waives a submitted stage. Only the plugin (on a panel action)
 * calls this — the agent cannot. Writes result.json + template_selection.json
 * (upstream contract) from the submitted recommendations: stage1 keeps the
 * nested `{stage, status, recommendations}` copy; stage2 assembles the FLAT
 * upstream final payload (`{stage:"final", status:"confirmed", ...}` with the
 * selected direction's fields and production params at top level — see
 * assembleFinalResult). Whitelisted user overrides (see STAGE_OVERRIDE_FIELDS)
 * are merged into the values before the write; the submission file itself
 * stays verbatim.
 *
 * Workbench-v2 T8: the stage-1 sidecar becomes the USER-authored template
 * selection `{ mode, roots }` — mode follows the effective `template_mode`
 * after overrides, roots are the candidate ids the workbench form collected
 * (channel field `templateSelection`). Upstream rule (confirm_ui.md): root
 * and kind choices NEVER enter result.json. Templates mode requires at least
 * one selected root (the upstream page refuses to submit empty); free design
 * ignores any stale selection payload. The upstream installer binding
 * (root_snapshots / selection_sha256) is a later milestone — the
 * conversation-guided installation chain is intentionally out of this scope.
 */
export function confirmStage(projectDir, stage, { waive = false, waiveReason = null, overrides = null, templateSelection = null } = {}, now = () => new Date().toISOString()) {
  if (!STAGES.includes(stage)) return { error: `stage 必须是 ${STAGES.join(" | ")}` };
  if (waive && !String(waiveReason ?? "").trim()) {
    return { error: "快速模式豁免必须给出 waiveReason" };
  }
  const { state } = loadState(projectDir);
  const stageState = state.stages[stage];
  if (stageState.status !== "submitted") {
    return { error: `${stage} 当前状态为 ${stageState.status}，只有 submitted 可确认` };
  }
  const confirmDir = join(projectDir, "confirm_ui");
  const recommendationsFile = join(confirmDir, `recommendations.${stage}.json`);
  if (!existsSync(recommendationsFile)) {
    return { error: "找不到提交的 recommendations 文件，请让助手重新提交" };
  }
  const recommendations = JSON.parse(readFileSync(recommendationsFile, "utf8"));
  if (waive) {
    stageState.status = "waived";
    stageState.waiveReason = String(waiveReason).slice(0, 500);
    stageState.confirmedAt = now();
    // Upstream quick semantics: no result.json, generation proceeds unlocked.
    // Waive ignores overrides entirely — nothing is written for the agent.
  } else {
    const merged = applyUserOverrides(stage, recommendations, overrides);
    if (stage === "stage2") {
      // Re-validate after overrides: an out-of-range selected index (agent
      // submission or user override) must never reach the assembled payload.
      const invalid = validateRecommendations(stage, recommendations);
      if (invalid) return { error: invalid };
    }
    // Workbench-v2 T8: resolve the user's template decision BEFORE anything
    // is written or the state flips. The mode is the effective `template_mode`
    // (agent submission merged with user override); the roots come from the
    // workbench channel, deduplicated — free design always resolves to an
    // empty list no matter what stale checkbox state the payload carries.
    const tplMode = recommendations.template_mode === "templates" ? "templates" : "free_design";
    const tplRoots = tplMode === "templates" && Array.isArray(templateSelection)
      ? [...new Set(templateSelection.map((r) => String(r).trim()).filter(Boolean))]
      : [];
    if (stage === "stage1" && tplMode === "templates" && tplRoots.length === 0) {
      return { error: "模板模式需至少选择一个候选" };
    }
    stageState.status = "confirmed";
    stageState.confirmedAt = now();
    stageState.waiveReason = null;
    // Workbench-v2 T5: stage2 writes the FLAT upstream final payload
    // ({stage:"final"}); stage1 keeps the nested recommendations copy.
    const payload = stage === "stage2"
      ? assembleFinalResult(recommendations)
      : { stage, status: "confirmed", recommendations };
    writeFileSync(join(confirmDir, "result.json"), JSON.stringify(payload, null, 2));
    if (stage === "stage1") {
      // Workbench-v2 T8: the user-authored selection sidecar — root/kind
      // choices live here, never in result.json (confirm_ui.md contract).
      writeFileSync(
        join(confirmDir, "template_selection.json"),
        JSON.stringify({ mode: tplMode, roots: tplRoots }, null, 2),
      );
    }
    if (merged) {
      // The fact of user editing lives in pipeline-state only — result.json
      // keeps the upstream shape with no extra wrapper key.
      if (merged.applied > 0) stageState.userEdited = true;
      if (merged.dropped > 0) stageState.overrideDropped = merged.dropped;
    }
  }
  // The spec gates are light confirmations: they close with the stage result
  // by default (the strategist corpus still requires the agent to run them).
  // Normalize first — a hand-edited state without the gate keys must not
  // crash the save below and leave the stage stuck on "submitted".
  const gateKey = stage === "stage1" ? "spec_gate1" : "spec_gate2";
  const gateState = (state.stages[gateKey] ??= { status: "pending" });
  if (gateState.status === "pending") {
    gateState.status = waive ? "waived" : "confirmed";
  }
  saveState(projectDir, state);
  return { state };
}

/**
 * The confirmed stage-2 direction's display name, resolved from the submitted
 * recommendations file — the flat final payload intentionally carries only the
 * applied components plus the `selected` index, never a direction id/name
 * (upstream: result.json stores components, not identity). Best-effort: null
 * when the submission file is gone or unreadable.
 */
function stage2SelectedDirectionName(projectDir) {
  try {
    const recs = JSON.parse(readFileSync(join(projectDir, "confirm_ui", "recommendations.stage2.json"), "utf8"));
    const ref = selectedDirectionRef(recs);
    if (!ref) return null;
    const index = Number.isSafeInteger(ref.index) && ref.index >= 0 && ref.index < ref.pool.length ? ref.index : 0;
    const direction = ref.pool[index];
    const name = direction && typeof direction === "object"
      ? [direction.name, direction.name_zh].find((v) => typeof v === "string" && v.trim())
      : undefined;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/** Agent-facing read of the user's decision — result.json is read ONCE. */
export function readStageResult(projectDir, stage) {
  if (!STAGES.includes(stage)) return { error: `stage 必须是 ${STAGES.join(" | ")}` };
  const { state } = loadState(projectDir);
  const stageState = state.stages[stage];
  if (stageState.status === "pending" || stageState.status === "submitted") {
    return {
      status: stageState.status,
      message:
        stageState.status === "submitted"
          ? "已提交，等待用户在 PPT 工作台「设计确认」区操作。请停止推进并等待；可用 ppt_stage_status 轮询。"
          : "尚未提交：先用 ppt_stage_submit 提交设计方案。",
    };
  }
  if (stageState.status === "waived") {
    return { status: "waived", waiveReason: stageState.waiveReason, message: "用户选择快速模式，可跳过该阶段确认继续。" };
  }
  const resultFile = join(projectDir, "confirm_ui", "result.json");
  if (!existsSync(resultFile)) return { status: "confirmed", message: "已确认（无 result.json 存档）" };
  if (stageState.resultRead) {
    return {
      status: "confirmed",
      alreadyRead: true,
      cachedSummary: stageState.resultSummary ?? null,
      warning: "result.json 只读一次：请使用缓存的摘要，不要重复读取",
    };
  }
  const result = JSON.parse(readFileSync(resultFile, "utf8"));
  stageState.resultRead = true;
  // Workbench-v2 T5: the stage2 summary surfaces the decision facts the agent
  // and workbench need — the winning direction's name and the three proactive
  // booleans — resolved with the upstream defaults when the written result
  // omits them (legacy nested results included). stage1 keeps the plain
  // recommendation-keys summary.
  const summary = {
    stage,
    confirmedAt: stageState.confirmedAt,
    keys: Object.keys(result.recommendations ?? result),
  };
  if (stage === "stage2") {
    summary.selectedDirection = stage2SelectedDirectionName(projectDir);
    summary.proactiveBooleans = {
      proactive_speaker_notes: typeof result.proactive_speaker_notes === "boolean" ? result.proactive_speaker_notes : true,
      proactive_custom_animations: result.proactive_custom_animations === true,
      proactive_narration_audio: result.proactive_narration_audio === true,
    };
  }
  stageState.resultSummary = summary;
  saveState(projectDir, state);
  return { status: "confirmed", result, message: "用户已确认（首次读取，此后请引用缓存摘要）" };
}

/**
 * Hard export gate: the post-processing trio refuses to run unless stage2 is
 * confirmed/waived AND the spec lock exists on disk.
 */
export function assertExportAllowed(projectDir) {
  const { state } = loadState(projectDir);
  const stage2 = state.stages.stage2.status;
  if (stage2 !== "confirmed" && stage2 !== "waived") {
    return {
      ok: false,
      code: "PPT_STAGE_NOT_CONFIRMED",
      hint: "Stage-2 设计方案尚未经用户确认：请调用 ppt_stage_submit 提交 recommendations，等待用户在 PPT 工作台「设计确认」区确认（或明确选择快速模式）后再导出。",
    };
  }
  if (!existsSync(join(projectDir, "spec_lock.md"))) {
    return {
      ok: false,
      code: "PPT_SPEC_LOCK_MISSING",
      hint: "缺少 spec_lock.md（规划执行锁）。请先完成 Strategist 规划落盘（design_spec.md + spec_lock.md）再导出。",
    };
  }
  return { ok: true, state };
}

// ---------------------------------------------------------------------------
// FR-PPT-13: per-project export preferences (the native-charts toggle).
// Persisted in the same pipeline-state.json so the preference survives
// restarts like every other stage fact; the export path reads it as the
// DEFAULT for svg_to_pptx's nativeChartsAndTables arg.
// ---------------------------------------------------------------------------

/** Only boolean switches live here — extend the whitelist deliberately. */
const EXPORT_PREF_KEYS = ["nativeChartsAndTables"];

export function getExportPrefs(projectDir) {
  const { state } = loadState(projectDir);
  const prefs = state?.exportPrefs;
  const out = {};
  for (const key of EXPORT_PREF_KEYS) {
    if (typeof prefs?.[key] === "boolean") out[key] = prefs[key];
  }
  return out;
}

export function setExportPrefs(projectDir, prefs) {
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
    return { error: "prefs 必须是对象" };
  }
  const { state } = loadState(projectDir);
  const merged = { ...(state.exportPrefs ?? {}) };
  for (const key of EXPORT_PREF_KEYS) {
    if (typeof prefs[key] === "boolean") merged[key] = prefs[key];
  }
  saveState(projectDir, { ...state, exportPrefs: merged });
  return { ok: true, prefs: merged };
}

// ---------------------------------------------------------------------------
// FR-PPT-04: page-level ops over the svg_output/svg_final dirs. Pages order
// alphabetically, so "move" swaps the two files' NAMES via a temp rename —
// bytes never change and the PXX numbering stays contiguous for the pipeline.
// ---------------------------------------------------------------------------

const PAGE_DIR_NAMES = new Set(["svg_output", "svg_final"]);
const PAGE_NAME_RE = /^[\w][\w.-]*\.svg$/i;

/** Resolve and contain a page path; null when anything smells off. */
function containedPagePath(projectDir, dir, name) {
  const cleanName = String(name ?? "");
  if (!PAGE_DIR_NAMES.has(dir) || !PAGE_NAME_RE.test(cleanName)) return null;
  const base = resolvePath(join(projectDir, dir));
  const full = resolvePath(join(base, cleanName));
  return full.startsWith(base + pathSep) ? full : null;
}

export function deletePage(projectDir, dir, name) {
  const full = containedPagePath(projectDir, dir, name);
  if (!full) return { error: "page 路径不合法" };
  if (!existsSync(full)) return { error: "页面不存在" };
  unlinkSync(full);
  return { ok: true };
}

export function movePage(projectDir, dir, name, direction) {
  if (direction !== "prev" && direction !== "next") {
    return { error: "direction 必须是 prev | next" };
  }
  const full = containedPagePath(projectDir, dir, name);
  if (!full) return { error: "page 路径不合法" };
  const siblings = readdirSync(join(projectDir, dir))
    .filter((entry) => PAGE_NAME_RE.test(entry))
    .sort();
  const index = siblings.indexOf(String(name));
  if (index === -1) return { error: "页面不存在" };
  const targetIndex = direction === "prev" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= siblings.length) {
    return { error: "已到边界" };
  }
  const target = siblings[targetIndex];
  const basePath = join(projectDir, dir);
  const tmpName = `__move_tmp_${String(name)}`;
  renameSync(join(basePath, String(name)), join(basePath, tmpName));
  renameSync(join(basePath, target), join(basePath, String(name)));
  renameSync(join(basePath, tmpName), join(basePath, target));
  return { ok: true, swappedWith: target };
}
