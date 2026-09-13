import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertExportAllowed,
  confirmStage,
  freshState,
  loadState,
  readStageResult,
  saveState,
  submitStage,
} from "../resources/plugins/laboflow.slides/lib/ppt-state.js";

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "ppt-state-"));
  writeFileSync(join(dir, "spec_lock.md"), "# spec lock\n");
  return dir;
}

test("fresh state has every stage pending", () => {
  const state = freshState("demo");
  assert.equal(state.version, 1);
  for (const stage of ["stage1", "stage2", "spec_gate1", "spec_gate2"]) {
    assert.equal(state.stages[stage].status, "pending");
  }
});

test("loadState reports created for a new project and survives round-trips", () => {
  const dir = makeProject();
  const first = loadState(dir);
  assert.equal(first.created, true);
  saveState(dir, first.state);
  const second = loadState(dir);
  assert.equal(second.created, false);
  assert.equal(second.state.stages.stage1.status, "pending");
});

test("submitStage rejects invalid payloads and writes upstream-format files", () => {
  const dir = makeProject();
  assert.match(submitStage(dir, "stage3", {}).error, /stage 必须是/);
  assert.match(submitStage(dir, "stage2", {}).error, /directions/);
  assert.match(submitStage(dir, "stage2", { directions: [] }).error, /directions/);

  const verdict = submitStage(dir, "stage1", { audience: "董事会", intent: "汇报" });
  assert.equal(verdict.error, undefined);
  assert.equal(verdict.state.stages.stage1.status, "submitted");
  assert.ok(existsSync(join(dir, "confirm_ui", "recommendations.stage1.json")));
  // stage2 without directions but quick:true is the quick-mode payload
  assert.equal(submitStage(dir, "stage2", { quick: true }).error, undefined);
});

test("double-submit after confirmation is refused (result immutability)", () => {
  const dir = makeProject();
  submitStage(dir, "stage1", { audience: "董事会" });
  confirmStage(dir, "stage1");
  const again = submitStage(dir, "stage1", { audience: "别人" });
  assert.match(again.error, /已确认/);
});

test("confirm requires a submitted stage and writes result.json once", () => {
  const dir = makeProject();
  assert.match(confirmStage(dir, "stage1").error, /只有 submitted 可确认/);
  submitStage(dir, "stage1", { audience: "董事会", templateSelection: { kind: "style", id: "mbb-consulting" } });
  assert.match(confirmStage(dir, "stage1", { waive: true }).error, /waiveReason/);
  const verdict = confirmStage(dir, "stage1");
  assert.equal(verdict.error, undefined);
  assert.equal(verdict.state.stages.stage1.status, "confirmed");
  assert.equal(verdict.state.stages.spec_gate1.status, "confirmed", "spec gate closes with the stage");
  assert.ok(existsSync(join(dir, "confirm_ui", "result.json")));
});

test("waive records the reason and unlocks without result.json", () => {
  const dir = makeProject();
  submitStage(dir, "stage2", { quick: true });
  const verdict = confirmStage(dir, "stage2", { waive: true, waiveReason: "user asked for quick mode" });
  assert.equal(verdict.state.stages.stage2.status, "waived");
  assert.equal(verdict.state.stages.stage2.waiveReason, "user asked for quick mode");
  assert.ok(!existsSync(join(dir, "confirm_ui", "result.json")), "quick mode writes no result.json");
});

test("readStageResult enforces read-once semantics on result.json", () => {
  const dir = makeProject();
  submitStage(dir, "stage2", { directions: [{ name: "深蓝咨询蓝" }, { name: "暖色编辑风" }, { name: "暗色科技" }] });
  const waiting = readStageResult(dir, "stage2");
  assert.equal(waiting.status, "submitted");
  assert.match(waiting.message, /等待/);

  confirmStage(dir, "stage2");
  const first = readStageResult(dir, "stage2");
  assert.equal(first.status, "confirmed");
  assert.ok(first.result, "first read returns the full result");
  const second = readStageResult(dir, "stage2");
  assert.equal(second.alreadyRead, true);
  assert.equal(second.result, undefined, "second read must NOT return the file again");
  assert.ok(second.cachedSummary);
  assert.match(second.warning, /只读一次/);
});

test("THE hard gate: export scripts refuse without stage2 confirmation (three states)", () => {
  // 1. no state at all
  const dirNoState = makeProject();
  const denied1 = assertExportAllowed(dirNoState);
  assert.equal(denied1.ok, false);
  assert.equal(denied1.code, "PPT_STAGE_NOT_CONFIRMED");

  // 2. submitted but not confirmed
  const dirSubmitted = makeProject();
  submitStage(dirSubmitted, "stage2", { directions: [{ name: "A" }, { name: "B" }, { name: "C" }] });
  const denied2 = assertExportAllowed(dirSubmitted);
  assert.equal(denied2.ok, false);
  assert.equal(denied2.code, "PPT_STAGE_NOT_CONFIRMED");

  // 3. confirmed + spec lock present → allowed
  const dirConfirmed = makeProject();
  submitStage(dirConfirmed, "stage2", { directions: [{ name: "A" }, { name: "B" }, { name: "C" }] });
  confirmStage(dirConfirmed, "stage2");
  const allowed = assertExportAllowed(dirConfirmed);
  assert.equal(allowed.ok, true);

  // 4. waived also unlocks (explicit quick mode)
  const dirWaived = makeProject();
  submitStage(dirWaived, "stage2", { quick: true });
  confirmStage(dirWaived, "stage2", { waive: true, waiveReason: "quick" });
  assert.equal(assertExportAllowed(dirWaived).ok, true);

  // 5. confirmed but spec_lock.md missing → still refused with a distinct code
  const dirNoLock = mkdtempSync(join(tmpdir(), "ppt-state-nolock-"));
  submitStage(dirNoLock, "stage2", { directions: [{ name: "A" }, { name: "B" }, { name: "C" }] });
  confirmStage(dirNoLock, "stage2");
  const denied3 = assertExportAllowed(dirNoLock);
  assert.equal(denied3.ok, false);
  assert.equal(denied3.code, "PPT_SPEC_LOCK_MISSING");
});

test("a corrupted state file quarantines and resets to pending (never guessed-confirmed)", () => {
  const dir = makeProject();
  saveState(dir, freshState("x"));
  writeFileSync(join(dir, "laboflow", "pipeline-state.json"), "{ not json !!!");
  const { state, corrupted } = loadState(dir);
  assert.equal(corrupted, true);
  assert.equal(state.stages.stage2.status, "pending");
  assert.equal(assertExportAllowed(dir).ok, false, "corrupt state must NOT unlock export");
});
