import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertExportAllowed,
  confirmStage,
  loadState,
  statePath,
  submitStage,
} from "../resources/plugins/laboflow.slides/lib/ppt-state.js";

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "ppt-state-"));
  mkdirSync(join(dir, "laboflow"), { recursive: true });
  mkdirSync(join(dir, "confirm_ui"), { recursive: true });
  return dir;
}

const RECS1 = { primary_language: "zh-CN", audience: "测试", template_choice: "free_design" };
const RECS2 = { directions: [{ name: "方向一" }, { name: "方向二" }, { name: "方向三" }] };

test("confirmStage flips the submitted stage to confirmed and closes its gate", () => {
  const dir = makeProject();
  try {
    const submitted = submitStage(dir, "stage1", RECS1);
    assert.ok(!submitted.error, submitted.error);
    assert.equal(loadState(dir).state.stages.stage1.status, "submitted");

    const result = confirmStage(dir, "stage1", {});
    assert.ok(!result.error, result.error);
    const state = loadState(dir).state;
    assert.equal(state.stages.stage1.status, "confirmed");
    assert.ok(state.stages.stage1.confirmedAt);
    assert.equal(state.stages.spec_gate1.status, "confirmed");
    // Decision record for the agent (upstream file protocol).
    const resultFile = join(dir, "confirm_ui", "result.json");
    assert.ok(existsSync(resultFile));
    assert.equal(JSON.parse(readFileSync(resultFile, "utf8")).status, "confirmed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hand-edited state without gate keys still saves the confirmation", () => {
  const dir = makeProject();
  try {
    submitStage(dir, "stage2", RECS2);
    // Malformed state: the spec-gate keys are missing entirely (hand edit).
    const path = statePath(dir);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    delete raw.stages.spec_gate1;
    delete raw.stages.spec_gate2;
    writeFileSync(path, JSON.stringify(raw, null, 2));

    const result = confirmStage(dir, "stage2", {});
    assert.ok(!result.error, result.error);
    const state = loadState(dir).state;
    assert.equal(state.stages.stage2.status, "confirmed");
    // The missing gates were normalized instead of crashing the save.
    assert.equal(state.stages.spec_gate2.status, "confirmed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waive requires a reason and skips result.json", () => {
  const dir = makeProject();
  try {
    submitStage(dir, "stage1", RECS1);
    assert.ok(confirmStage(dir, "stage1", { waive: true }).error, "waive without reason must fail");
    const result = confirmStage(dir, "stage1", { waive: true, waiveReason: "用户选择快速模式" });
    assert.ok(!result.error, result.error);
    const state = loadState(dir).state;
    assert.equal(state.stages.stage1.status, "waived");
    assert.equal(state.stages.spec_gate1.status, "waived");
    assert.ok(!existsSync(join(dir, "confirm_ui", "result.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("double confirmation is refused and the export gate opens only after stage2", () => {
  const dir = makeProject();
  try {
    submitStage(dir, "stage1", RECS1);
    submitStage(dir, "stage2", RECS2);
    assert.ok(confirmStage(dir, "stage1", {}).state);
    const twice = confirmStage(dir, "stage1", {});
    assert.match(twice.error, /已确认|只有 submitted/);

    // stage1 alone does not unlock exports.
    assert.equal(assertExportAllowed(dir).code, "PPT_STAGE_NOT_CONFIRMED");
    writeFileSync(join(dir, "spec_lock.md"), "lock\n");
    assert.equal(assertExportAllowed(dir).code, "PPT_STAGE_NOT_CONFIRMED");
    confirmStage(dir, "stage2", {});
    assert.ok(assertExportAllowed(dir).ok);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
