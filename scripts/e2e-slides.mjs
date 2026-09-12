#!/usr/bin/env node
/**
 * LaboFlow Slides plugin e2e (headless, protocol-free, cross-platform).
 *
 * Exercises the two engine paths end-to-end without a GUI or network:
 *   L1 fast path   — normalize a real outline, export an editable PPTX into a
 *                    temp workspace, verify zip/XML structure.
 *   L2 diagnostics — runtime five-state detection, corpus read bridge
 *                    (allow + refuse), script whitelist (unknown refused),
 *                    and the Stage-2 hard export gate (unconfirmed denied →
 *                    confirmed via the panel contract → allowed).
 *
 * No env needed; exit code 0 = all assertions passed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = join(root, "apps", "desktop", "resources", "plugins", "laboflow.slides");
const runtime = await import(`${pluginDir}/lib/ppt-runtime.js`);
const state = await import(`${pluginDir}/lib/ppt-state.js`);
const script = await import(`${pluginDir}/lib/ppt-script.js`);
const readDoc = await import(`${pluginDir}/lib/ppt-read-doc.js`);
const slides = await import(`${pluginDir}/lib/slides.js`);

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✔ ${name}`);
};

// ── L1 fast path ─────────────────────────────────────────────────────────────
{
  const workspace = mkdtempSync(join(tmpdir(), "e2e-slides-l1-"));
  const deck = {
    deckTitle: "e2e 快速引擎验证",
    pages: [
      { layout: "title", title: "e2e 快速引擎验证", subtitle: "LaboFlow" },
      { layout: "data", title: "两项关键指标", data: { metrics: [{ label: "增速", value: "12%" }] } },
      { layout: "compare", title: "方案对比", columns: [
        { label: "维度", rows: ["成本"] },
        { label: "自建", rows: ["高"] },
      ] },
    ],
  };
  const { normalized, buffer } = await slides.exportDeckToBuffer(deck, { accent: "1F4E79" });
  assert.equal(normalized.pages.length, 3);
  const outDir = join(workspace, "slides");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "e2e快速引擎验证.pptx");
  writeFileSync(outPath, buffer);
  assert.ok(existsSync(outPath));
  assert.deepEqual([...buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], "pptx must be a real zip");
  ok(`L1 快速路径：3 页可编辑 PPTX 导出成功（${buffer.length} bytes）`);
}

// ── L2 diagnostics: runtime five-state ───────────────────────────────────────
{
  const dataDir = mkdtempSync(join(tmpdir(), "e2e-slides-l2-"));
  const deps = { pluginDir, dataDir };
  const missing = await runtime.detectRuntime(deps);
  assert.equal(missing.stage, "venv-missing");
  assert.ok(missing.doctor, "doctor advice required for venv-missing");
  ok(`L2 诊断：venv-missing 状态与 doctor 提示正常（${missing.venvPath.slice(-40)}）`);
  await assert.rejects(
    () => runtime.runVendoredScript(deps, "scripts/svg_quality_checker.py", ["x"]),
    (error) => error.errorCode === "PPT_RUNTIME_NOT_READY",
  );
  ok("L2 诊断：venv 缺失时脚本执行被拒绝（PPT_RUNTIME_NOT_READY）");
}

// ── L2 corpus bridge ─────────────────────────────────────────────────────────
{
  const entry = readDoc.resolveDocEntry(join(pluginDir, "vendored", "ppt-master"), "workflows/routing.md");
  assert.equal(entry.ok, true);
  assert.ok(readFileSync(entry.absPath, "utf8").includes("route"));
  const denied = readDoc.resolveDocEntry(join(pluginDir, "vendored", "ppt-master"), "../package.json");
  assert.equal(denied.ok, false);
  ok("L2 语料桥：白名单可读 + 穿越拒绝");
}

// ── L2 whitelist + hard export gate ──────────────────────────────────────────
{
  const workspace = mkdtempSync(join(tmpdir(), "e2e-slides-gate-"));
  const projectDir = join(workspace, "projects", "demo_20260912");
  mkdirSync(projectDir, { recursive: true });

  const deniedScript = script.planScript({
    pluginDir,
    script: "does_not_exist",
    args: {},
    exportGate: (dir) => state.assertExportAllowed(dir),
  });
  assert.equal(deniedScript.code, "PPT_SCRIPT_NOT_ALLOWED");

  const gateDenied = script.planScript({
    pluginDir,
    script: "svg_to_pptx",
    args: { projectPath: projectDir },
    exportGate: (dir) => state.assertExportAllowed(dir),
  });
  assert.equal(gateDenied.ok, false);
  assert.equal(gateDenied.code, "PPT_STAGE_NOT_CONFIRMED");
  ok("L2 门禁：未确认项目导出被拒（PPT_STAGE_NOT_CONFIRMED）");

  // Simulate the panel contract: submit → user confirms → gate opens.
  const submitted = state.submitStage(projectDir, "stage2", { directions: [{ name: "A" }, { name: "B" }, { name: "C" }] });
  assert.equal(submitted.state.stages.stage2.status, "submitted");
  const pending = state.readStageResult(projectDir, "stage2");
  assert.equal(pending.status, "submitted");
  state.confirmStage(projectDir, "stage2");
  writeFileSync(join(projectDir, "spec_lock.md"), "# lock\n");
  const gateOpen = script.planScript({
    pluginDir,
    script: "svg_to_pptx",
    args: { projectPath: projectDir },
    exportGate: (dir) => state.assertExportAllowed(dir),
  });
  assert.equal(gateOpen.ok, true);
  assert.deepEqual(gateOpen.argv, [projectDir]);
  ok("L2 门禁：确认后（result.json + spec_lock）导出放行，argspec 保真");
}

console.log(`\ne2e-slides: ${passed} checks passed on ${process.platform}`);
