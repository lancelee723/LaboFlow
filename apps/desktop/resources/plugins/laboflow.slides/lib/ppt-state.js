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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  }
  return null;
}

/** Agent submits its recommendations for a stage → panel opens, user decides. */
export function submitStage(projectDir, stage, recommendations, now = () => new Date().toISOString(), estimate) {
  if (!STAGES.includes(stage)) return { error: `stage 必须是 ${STAGES.join(" | ")}` };
  const invalid = validateRecommendations(stage, recommendations);
  if (invalid) return { error: invalid };
  const { state, corrupted } = loadState(projectDir);
  const stageState = state.stages[stage];
  if (stageState.status === "confirmed" || stageState.status === "waived") {
    return { error: `${stage} 已确认，无需重复提交；如需改选请新建项目或请用户在确认卡上重新提交`, state };
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
 * (upstream contract) from the submitted recommendations.
 */
export function confirmStage(projectDir, stage, { waive = false, waiveReason = null } = {}, now = () => new Date().toISOString()) {
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
  } else {
    stageState.status = "confirmed";
    stageState.confirmedAt = now();
    stageState.waiveReason = null;
    writeFileSync(join(confirmDir, "result.json"), JSON.stringify({ stage, status: "confirmed", recommendations }, null, 2));
    if (stage === "stage1") {
      const selection = recommendations.templateSelection ?? recommendations.template_selection ?? { source: "recommendations" };
      writeFileSync(join(confirmDir, "template_selection.json"), JSON.stringify(selection, null, 2));
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
          ? "已提交，等待用户在确认卡上操作。请停止推进并等待；可用 ppt_stage_status 轮询。"
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
  stageState.resultSummary = {
    stage,
    confirmedAt: stageState.confirmedAt,
    keys: Object.keys(result.recommendations ?? {}),
  };
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
      hint: "Stage-2 设计方案尚未经用户确认：请调用 ppt_stage_submit 提交 recommendations，等待用户在确认卡上确认（或明确选择快速模式）后再导出。",
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
