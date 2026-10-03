/**
 * REAL Python integration for the PPT-Master runtime channel.
 *
 * Gated behind PPT_IT=1 (runs locally or on an opt-in CI job with a pip/uv
 * cache): builds an actual venv from requirements-laboflow.txt, asserts the
 * AGPL/GPL blacklist, and runs one upstream script end-to-end. Everything
 * here is a no-op (pass-through) without the flag so the default desktop
 * suite stays hermetic.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectRuntime,
  ensureRuntime,
  findForbiddenDistributions,
  freezeDistributions,
  runVendoredScript,
  skillRoot,
} from "../resources/plugins/laboflow.slides/lib/ppt-runtime.js";

const REAL_PLUGIN_DIR = fileURLToPath(new URL("../resources/plugins/laboflow.slides/", import.meta.url));
const IT_ENABLED = process.env.PPT_IT === "1";
const options = { skip: IT_ENABLED ? false : "PPT_IT=1 未启用：真机集成测试跳过" };

test(
  "real setup: fresh venv → requirements → guard → ready within the time budget",
  { skip: options.skip },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ppt-it-"));
    const startedAt = Date.now();
    const logs = [];
    const status = await ensureRuntime({ pluginDir: REAL_PLUGIN_DIR, dataDir }, (line) => logs.push(line));
    const elapsedMinutes = (Date.now() - startedAt) / 60_000;
    assert.equal(status.stage, "ready");
    assert.ok(
      elapsedMinutes <= 8,
      `setup must finish within 8 minutes on a direct connection, took ${elapsedMinutes.toFixed(1)}`,
    );
  },
  16 * 60_000,
);

test(
  "real runtime: freeze blacklist is empty and the vendored checker runs",
  { skip: options.skip },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ppt-it2-"));
    // Reuse whatever the previous test built by pointing at the same layout:
    // build here if absent (idempotent when the first test already ran).
    const pre = await detectRuntime({ pluginDir: REAL_PLUGIN_DIR, dataDir });
    if (pre.stage !== "ready") {
      await ensureRuntime({ pluginDir: REAL_PLUGIN_DIR, dataDir }, () => {});
    }
    const frozen = await freezeDistributions({ pluginDir: REAL_PLUGIN_DIR, dataDir });
    assert.ok(Array.isArray(frozen) && frozen.length > 0, "pip freeze must list packages");
    assert.deepEqual(
      findForbiddenDistributions(frozen),
      [],
      `AGPL/GPL blacklist must be empty, got: ${findForbiddenDistributions(frozen).join(", ")}`,
    );
    const checker = join(skillRoot(REAL_PLUGIN_DIR), "scripts", "svg_quality_checker.py");
    const run = await runVendoredScript(
      { pluginDir: REAL_PLUGIN_DIR, dataDir },
      "scripts/svg_quality_checker.py",
      ["--help"],
      { timeoutMs: 120_000 },
    );
    assert.equal(run.code, 0, `checker --help must exit 0 via ${checker}`);
  },
  16 * 60_000,
);

test(
  "real pipeline smoke: init → design files → SVG page → gates → finalize → export (DEVPLAN B.⑦)",
  { skip: options.skip },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ppt-it3-"));
    const workspace = mkdtempSync(join(tmpdir(), "ppt-it3-ws-"));
    const deps = { pluginDir: REAL_PLUGIN_DIR, dataDir };
    const pre = await detectRuntime(deps);
    if (pre.stage !== "ready") await ensureRuntime(deps, () => {});

    const run = (scriptRel, argv, cwd) =>
      runVendoredScript(deps, scriptRel, argv, { cwd, timeoutMs: 300_000 });

    // 1. project init — `--dir` redirects the projects root into the temp
    // workspace (the upstream default would resolve against the skill dir).
    const init = await run(
      "scripts/project_manager.py",
      ["init", "e2e_smoke", "--dir", join(workspace, "projects"), "--format", "ppt169"],
      workspace,
    );
    assert.equal(init.code, 0, `init failed: ${init.stderr.slice(-500)}`);
    // Upstream naming: <name>_<format>_<YYYYMMDD>.
    const projectsRoot = join(workspace, "projects");
    const created = readdirSync(projectsRoot).filter((name) => name.startsWith("e2e_smoke"));
    assert.ok(created.length === 1, `expected one scaffolded project, got ${created.join(", ")}`);
    const projectDir = join(projectsRoot, created[0]);
    assert.ok(existsSync(join(projectDir, "svg_output")), "init must scaffold svg_output/");

    // 2. planner artifacts the gate requires: the exporter reads typography
    // title/body rows and pptx_structure.mode from spec_lock.md.
    writeFileSync(
      join(projectDir, "design_spec.md"),
      [
        "# design spec (e2e sample)",
        "",
        "## IX. Content Outline",
        "",
        "### Part 1: Opening",
        "",
        "#### Slide 01 - Cover",
        "",
        "- **Audience move**: unaware → aware the smoke test exists",
        "- **Relationships**: none",
        "- **Composition**: full-bleed dark field, single title block",
        "- **Title**: E2E smoke title",
        "- **Core message**: The vendored PPT-Master pipeline works inside LaboFlow.",
        "- **Content**: Deck title and subtitle only.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(projectDir, "spec_lock.md"),
      [
        "## communication",
        "- primary_language: en-US",
        "- audience: LaboFlow engineering reviewers",
        "- objective: Prove the L2 pipeline smoke path runs end to end.",
        "- core_message: The vendored PPT-Master pipeline works inside LaboFlow.",
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
        "- P01: anchor",
        "",
      ].join("\n"),
    );

    // 3. one minimal valid page: the checker tells us if the SVG is off-contract.
    writeFileSync(
      join(projectDir, "svg_output", "01_cover.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#051C2C"/>
  <text x="80" y="200" font-family="Arial" font-size="44" fill="#FFFFFF">E2E smoke title</text>
  <text x="80" y="280" font-family="Arial" font-size="20" fill="#B8C4D0">native pipeline check</text>
</svg>`,
    );

    // 4. quality gates (early then final) — report must exist for the exporter.
    for (const stage of ["early", "final"]) {
      const check = await run(
        "scripts/svg_quality_checker.py",
        [projectDir, "--stage", stage, "--json"],
        workspace,
      );
      assert.equal(check.code, 0, `checker ${stage} failed: ${(check.stdout + check.stderr).slice(-4000)}`);
    }

    // 5. finalize → svg_final/ (self-contained preview)
    const finalize = await run("scripts/finalize_svg.py", [projectDir], workspace);
    assert.equal(finalize.code, 0, `finalize failed: ${finalize.stderr.slice(-500)}`);
    assert.ok(existsSync(join(projectDir, "svg_final")), "finalize must produce svg_final/");

    // 6. export → exports/*.pptx (native DrawingML)
    const exportRun = await run(
      "scripts/svg_to_pptx.py",
      [projectDir, "-o", join(projectDir, "exports", "e2e_smoke.pptx"), "-f", "ppt169"],
      workspace,
    );
    assert.equal(exportRun.code, 0, `export failed: ${exportRun.stderr.slice(-800)}`);
    const pptxPath = join(projectDir, "exports", "e2e_smoke.pptx");
    assert.ok(existsSync(pptxPath), "pptx must be written");
    const pptx = readFileSync(pptxPath);
    assert.deepEqual([...pptx.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], "export must be a real zip");
    // POSTFLIGHT receipt from the upstream exporter.
    assert.ok(
      existsSync(join(projectDir, "validation")) || (exportRun.stdout + exportRun.stderr).includes("report"),
      "postflight receipt expected",
    );
  },
  16 * 60_000,
);
