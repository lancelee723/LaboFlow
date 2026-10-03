/**
 * Panel bridge regression (the confirm-card bug, 2026-09-13):
 * the card could not be acted on because a rejected bridge call bricked its
 * buttons, and it showed three stray lines because nested recommendation
 * objects were dropped. These tests pin the plugin-side contract of
 * onPanelInvoke: cached runtime status, disk recovery of a submitted stage,
 * state/recommendations serving, confirm/waive, and input validation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = join(
  fileURLToPath(new URL("../resources/plugins/laboflow.slides/", import.meta.url)),
);

const workspaces = [];
async function loadPlugin({ workspace }) {
  const pluginDataDir = mkdtempSync(join(tmpdir(), "ppt-panel-data-"));
  globalThis.pi = {
    agent: { registerTool: async () => {} },
    plugin: { getSettings: async () => ({}), getDataPath: async () => pluginDataDir },
    workspace: { get: async () => ({ path: workspace, name: "ws" }) },
    commands: { register: async () => {} },
    ui: {
      openPanel: async () => {},
      showToast: async () => {},
      showNativeNotification: async () => {},
    },
    log: () => {},
  };
  const module = await import(`${PLUGIN_DIR}/main.js?t=${Date.now()}-${Math.random()}`);
  await module.onLoad();
  return {
    invoke: (channel, payload) => module.onPanelInvoke(channel, payload ?? {}),
    cleanup: () => rmSync(pluginDataDir, { recursive: true, force: true }),
  };
}

function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "ppt-panel-ws-"));
  workspaces.push(ws);
  mkdirSync(join(ws, "projects"), { recursive: true });
  return ws;
}

test("getBootstrap serves no pending when nothing was submitted", async () => {
  const ws = makeWorkspace();
  const panel = await loadPlugin({ workspace: ws });
  const boot = await panel.invoke("ppt.getBootstrap");
  assert.equal(boot.pending, null);
  assert.ok(boot.runtime?.stage, "runtime status present");
  panel.cleanup();
});

test("getBootstrap recovers a submitted stage from disk after a plugin reload", async () => {
  const ws = makeWorkspace();
  // First life: agent submits Stage-2 via the tool contract.
  const first = await loadPlugin({ workspace: ws });
  const projectDir = join(ws, "projects", "demo_20260913");
  mkdirSync(projectDir, { recursive: true });
  const { submitStage } = await import(`${PLUGIN_DIR}/lib/ppt-state.js`);
  submitStage(projectDir, "stage2", { directions: [{ name: "A" }, { name: "B" }, { name: "C" }] });
  first.cleanup();

  // Second life: fresh process, in-memory pendingConfirm is gone — the disk
  // record must bring the waiting stage back so the card is actionable.
  const second = await loadPlugin({ workspace: ws });
  const boot = await second.invoke("ppt.getBootstrap");
  assert.ok(boot.pending, "pending recovered from pipeline-state.json");
  assert.equal(boot.pending.stage, "stage2");
  assert.equal(boot.pending.projectDir, projectDir);

  // And the card can actually confirm it through the bridge.
  const confirmed = await second.invoke("ppt.confirmStage", { projectDir, stage: "stage2" });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.state.stages.stage2.status, "confirmed");
  assert.ok(existsSync(join(projectDir, "confirm_ui", "result.json")));
  // After the action the pending slot clears (next bootstrap shows nothing).
  const after = await second.invoke("ppt.getBootstrap");
  assert.equal(after.pending, null);
  second.cleanup();
});

test("getState serves the full recommendations the agent submitted", async () => {
  const ws = makeWorkspace();
  const panel = await loadPlugin({ workspace: ws });
  const projectDir = join(ws, "projects", "demo2_20260913");
  mkdirSync(join(projectDir, "confirm_ui"), { recursive: true });
  const recommendations = {
    primary_language: "zh-CN",
    communication: { audience: "市委市政府", intent: "三段汇报" },
    stage: "stage1",
  };
  writeFileSync(
    join(projectDir, "confirm_ui", "recommendations.stage1.json"),
    JSON.stringify(recommendations, null, 2),
  );
  const { loadState, saveState, freshState } = await import(`${PLUGIN_DIR}/lib/ppt-state.js`);
  const state = freshState("demo2");
  state.stages.stage1.status = "submitted";
  saveState(projectDir, state);
  void loadState;

  const view = await panel.invoke("ppt.getState", { projectDir });
  assert.deepEqual(view.recommendations.stage1, recommendations, "nested contract must survive the bridge");
  assert.equal(view.state.stages.stage1.status, "submitted");
  panel.cleanup();
});

test("confirmStage rejects an unsubmitted stage with an error payload (not a throw)", async () => {
  const ws = makeWorkspace();
  const panel = await loadPlugin({ workspace: ws });
  const projectDir = join(ws, "projects", "demo3_20260913");
  mkdirSync(projectDir, { recursive: true });
  const result = await panel.invoke("ppt.confirmStage", { projectDir, stage: "stage2" });
  assert.match(String(result.error), /submitted/);
  panel.cleanup();
});

test("readSvg refuses non-svg paths; openPath refuses missing paths", async () => {
  const ws = makeWorkspace();
  const panel = await loadPlugin({ workspace: ws });
  const notSvg = await panel.invoke("ppt.readSvg", { path: "/etc/passwd" });
  assert.match(String(notSvg.error), /svg/i);
  const missing = await panel.invoke("ppt.openPath", { path: "/definitely/not/there" });
  assert.match(String(missing.error), /不存在/);
  panel.cleanup();
});

test("unknown channels answer with an error instead of hanging the card", async () => {
  const ws = makeWorkspace();
  const panel = await loadPlugin({ workspace: ws });
  const result = await panel.invoke("ppt.nope", {});
  assert.match(String(result.error), /unknown channel/);
  panel.cleanup();
});
