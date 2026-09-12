import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { EXPORT_SCRIPTS, planScript, PPT_SCRIPTS } from "../resources/plugins/laboflow.slides/lib/ppt-script.js";
import { assertExportAllowed } from "../resources/plugins/laboflow.slides/lib/ppt-state.js";

const PLUGIN_DIR = "/plugins/laboflow.slides";
const plan = (script, args, exportGate) =>
  planScript({ pluginDir: PLUGIN_DIR, script, args, exportGate: exportGate ?? (() => ({ ok: true })) });

test("the whitelist is exactly the deterministic tail (8 pinned entries)", () => {
  assert.deepEqual(Object.keys(PPT_SCRIPTS).sort(), [
    "finalize_svg",
    "image_search",
    "project_manager",
    "quality_checker",
    "source_to_md",
    "svg_to_pptx",
    "text_measure",
    "total_md_split",
  ]);
  assert.deepEqual(EXPORT_SCRIPTS.sort(), ["finalize_svg", "svg_to_pptx", "total_md_split"]);
});

test("unknown scripts are refused with a structured code", () => {
  const verdict = plan("rm_rf", {});
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "PPT_SCRIPT_NOT_ALLOWED");
  assert.match(verdict.error, /白名单/);
});

test("argspec snapshot: project_manager subcommands mirror upstream argparse", () => {
  assert.deepEqual(plan("project_manager", { subcommand: "init", name: "demo", dir: "/w/projects" }).argv, [
    "init", "demo", "--dir", "/w/projects",
  ]);
  assert.deepEqual(
    plan("project_manager", { subcommand: "init", name: "demo", dir: "/w/projects", format: "ppt169" }).argv,
    ["init", "demo", "--dir", "/w/projects", "--format", "ppt169"],
  );
  // LaboFlow must always redirect the projects root into the workspace — the
  // upstream default resolves against the vendored skill location.
  assert.equal(plan("project_manager", { subcommand: "init", name: "demo" }).code, "PPT_SCRIPT_INVALID_ARGS");
  assert.deepEqual(
    plan("project_manager", { subcommand: "import-sources", projectPath: "/w/projects/demo", sources: ["/w/sources/a.docx"] }).argv,
    ["import-sources", "/w/projects/demo", "/w/sources/a.docx"],
  );
  assert.deepEqual(plan("project_manager", { subcommand: "validate", projectPath: "/w/projects/demo" }).argv, [
    "validate", "/w/projects/demo",
  ]);
  assert.equal(plan("project_manager", { subcommand: "nope" }).ok, false);
});

test("argspec snapshot: quality_checker takes the positional target + stage flags", () => {
  const verdict = plan("quality_checker", { target: "/w/projects/demo/svg_output", stage: "final" });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.argv, ["/w/projects/demo/svg_output", "--stage", "final", "--json"]);
  assert.ok(verdict.scriptPath.endsWith(join("scripts", "svg_quality_checker.py")));
  // Upstream regression: the checker REQUIRES the positional target — the old
  // dead wrapper passed none and argparse died.
  assert.equal(plan("quality_checker", {}).code, "PPT_SCRIPT_INVALID_ARGS");
});

test("argspec snapshot: finalize/total_md_split take their positional project dir", () => {
  assert.deepEqual(plan("finalize_svg", { projectDir: "/w/projects/demo" }).argv, ["/w/projects/demo"]);
  assert.deepEqual(plan("finalize_svg", { projectDir: "/w/projects/demo", dryRun: true }).argv, [
    "/w/projects/demo", "--dry-run",
  ]);
  assert.deepEqual(plan("total_md_split", { projectPath: "/w/projects/demo", quiet: true }).argv, [
    "/w/projects/demo", "-q",
  ]);
  assert.equal(plan("finalize_svg", {}).code, "PPT_SCRIPT_INVALID_ARGS");
  assert.equal(plan("total_md_split", {}).code, "PPT_SCRIPT_INVALID_ARGS");
});

test("argspec snapshot: svg_to_pptx keeps -s project-relative (never absolute)", () => {
  const verdict = plan("svg_to_pptx", {
    projectPath: "/w/projects/demo",
    output: "/w/slides/out.pptx",
    source: "svg_output",
    format: "ppt169",
    nativeChartsAndTables: true,
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.argv, [
    "/w/projects/demo", "-o", "/w/slides/out.pptx", "-s", "svg_output", "-f", "ppt169",
    "--native-charts-and-tables",
  ]);
  assert.equal(plan("svg_to_pptx", {}).code, "PPT_SCRIPT_INVALID_ARGS");
});

test("argspec snapshot: text_measure calibrate and image_search", () => {
  assert.deepEqual(plan("text_measure", { projectPath: "/w/projects/demo", outline: true }).argv, [
    "calibrate", "/w/projects/demo", "--outline", "--json",
  ]);
  const search = plan("image_search", { query: "蓝图 工业园区", filename: "cover.jpg", output: "/w/projects/demo/images" });
  assert.deepEqual(search.argv, ["蓝图 工业园区", "--filename", "cover.jpg", "-o", "/w/projects/demo/images"]);
});

test("source_to_md refuses PDF with actionable guidance (AGPL route stays dead)", () => {
  const verdict = plan("source_to_md", { source: "/w/sources/report.pdf" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /PDF|AGPL|docx/i);
  assert.equal(plan("source_to_md", { source: "/w/sources/report.docx" }).ok, true);
});

test("export trio inherits the hard gate verdict from ppt-state", () => {
  const gateDenied = () => ({ ok: false, code: "PPT_STAGE_NOT_CONFIRMED", hint: "请先确认" });
  const denied = plan("svg_to_pptx", { projectPath: "/w/projects/demo" }, gateDenied);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "PPT_STAGE_NOT_CONFIRMED");
  assert.equal(denied.gate, true);
  // non-export scripts bypass the gate entirely
  assert.equal(plan("quality_checker", { target: "/x" }, gateDenied).ok, true);
});

test("real ppt-state gate wiring: unconfirmed project cannot plan an export", () => {
  // End-to-end through the real assertExportAllowed (no state on disk).
  const verdict = plan("finalize_svg", { projectDir: "/w/projects/none" }, assertExportAllowed);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "PPT_STAGE_NOT_CONFIRMED");
});
