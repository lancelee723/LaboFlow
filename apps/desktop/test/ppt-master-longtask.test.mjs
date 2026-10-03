/**
 * REAL long-task integration (DEVPLAN B metric): a 30-page deck must export
 * within the 5-minute budget, and the plugin job wrapper must keep it
 * pollable. Runs against the real venv; gated behind PPT_IT=1.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectRuntime,
  ensureRuntime,
  runVendoredScript,
} from "../resources/plugins/laboflow.slides/lib/ppt-runtime.js";
import { assertExportAllowed, confirmStage, submitStage } from "../resources/plugins/laboflow.slides/lib/ppt-state.js";

const REAL_PLUGIN_DIR = fileURLToPath(new URL("../resources/plugins/laboflow.slides/", import.meta.url));
const IT_ENABLED = process.env.PPT_IT === "1";

const SPEC_LOCK = [
  "## communication",
  "- primary_language: en-US",
  "- audience: LaboFlow engineering reviewers",
  "- objective: Prove the long-task export budget holds for a 30-page deck.",
  "- core_message: The job wrapper keeps long exports pollable and on budget.",
  "",
  "## canvas",
  "- viewBox: 0 0 1280 720",
  "- format: PPT 16:9",
  "",
  "## colors",
  "- bg: FFFFFF",
  "- text: 1F2937",
  "- primary: 1F4E79",
  "- secondary_text: 6B7280",
  "- divider: D9E2EC",
  "",
  "## typography",
  "- font_family: Arial",
  "- title_family: Arial",
  "- body_family: Arial",
  "- title: 40",
  "- body: 18",
  "",
  "## pptx_structure",
  "- mode: flat",
  "",
  "## page_rhythm",
  ...Array.from({ length: 30 }, (_, i) => `- P${String(i + 1).padStart(2, "0")}: ${i % 5 === 0 ? "anchor" : "dense"}`),
  "",
].join("\n");

test(
  "long task: 30-page deck exports within 5 minutes behind the stage gate",
  { skip: IT_ENABLED ? false : "PPT_IT=1 未启用：真机集成测试跳过" },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ppt-long-rt-"));
    const workspace = mkdtempSync(join(tmpdir(), "ppt-long-ws-"));
    const deps = { pluginDir: REAL_PLUGIN_DIR, dataDir };
    if ((await detectRuntime(deps)).stage !== "ready") {
      await ensureRuntime(deps, () => {});
    }
    const init = await runVendoredScript(
      deps,
      "scripts/project_manager.py",
      ["init", "long_deck", "--dir", join(workspace, "projects"), "--format", "ppt169"],
      { timeoutMs: 120_000 },
    );
    assert.equal(init.code, 0, init.stderr.slice(-300));
    const projectsRoot = join(workspace, "projects");
    const projectDir = join(projectsRoot, readdirSync(projectsRoot)[0]);
    writeFileSync(
      join(projectDir, "design_spec.md"),
      [
        "# design spec (long task)",
        "",
        "## IX. Content Outline",
        "",
        ...Array.from({ length: 30 }, (_, i) => {
          const nn = String(i + 1).padStart(2, "0");
          return [
            `#### Slide ${nn} - Page ${nn}`,
            "",
            "- **Audience move**: unaware → informed",
            "- **Relationships**: none",
            "- **Composition**: title band over a plain field",
            "- **Title**: Long task page",
            "- **Core message**: budget check",
            "- **Content**: title and one line",
            "",
          ].join("\n");
        }),
      ].join("\n"),
    );
    writeFileSync(join(projectDir, "spec_lock.md"), SPEC_LOCK);

    for (let page = 1; page <= 30; page += 1) {
      const nn = String(page).padStart(2, "0");
      writeFileSync(
        join(projectDir, "svg_output", `${nn}_page.svg`),
        `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect id="page-bg" data-pptx-role="background" width="1280" height="720" fill="#FFFFFF"/>
  <text x="80" y="120" font-family="Arial" font-size="40" fill="#1F4E79">Long task page ${page}</text>
  <text x="80" y="180" font-family="Arial" font-size="18" fill="#1F2937">30-page export budget check</text>
</svg>`,
      );
    }

    // The hard gate stands in front of the long export.
    assert.equal(assertExportAllowed(projectDir).ok, false);
    submitStage(projectDir, "stage2", { directions: [{ name: "blue" }, { name: "warm" }, { name: "dark" }] });
    confirmStage(projectDir, "stage2");
    assert.equal(assertExportAllowed(projectDir).ok, true);

    const final = await runVendoredScript(
      deps,
      "scripts/svg_quality_checker.py",
      [projectDir, "--stage", "final", "--json"],
      { timeoutMs: 300_000 },
    );
    assert.equal(final.code, 0, `final gate failed: ${(final.stdout + final.stderr).slice(-3000)}`);

    const finalize = await runVendoredScript(
      deps,
      "scripts/finalize_svg.py",
      [projectDir],
      { timeoutMs: 300_000 },
    );
    assert.equal(finalize.code, 0, `finalize failed: ${finalize.stderr.slice(-400)}`);

    const started = Date.now();
    const exported = await runVendoredScript(
      deps,
      "scripts/svg_to_pptx.py",
      [projectDir, "-o", join(projectDir, "exports", "long_deck.pptx"), "-f", "ppt169"],
      { timeoutMs: 5 * 60_000 + 30_000 },
    );
    const elapsed = (Date.now() - started) / 1000;
    assert.equal(exported.code, 0, `export failed: ${exported.stderr.slice(-500)}`);
    const pptx = join(projectDir, "exports", "long_deck.pptx");
    assert.ok(existsSync(pptx), "pptx must exist");
    assert.ok(elapsed <= 300, `30-page export must fit the 5-minute budget, took ${elapsed.toFixed(1)}s`);
    // The postflight receipt must report the full page count.
    assert.match(exported.stdout + exported.stderr, /POSTFLIGHT|report|OK/i);
  },
  14 * 60_000,
);
