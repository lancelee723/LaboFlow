import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { extractExportedPptxPaths, isSlidesExportResult, maybeRegisterSlidesArtifact } =
  await import("../electron/main/laboflow/slides-artifacts.ts");

test("extracts pptx paths from CJK workspace tool output", () => {
  const text =
    "导出完成：apps/projects/验收项目_20261002/exports/验收项目_20261002_013056.pptx（3 页）\n" +
    "postflight: passed-with-warnings";
  assert.deepEqual(
    extractExportedPptxPaths({ content: text }),
    ["apps/projects/验收项目_20261002/exports/验收项目_20261002_013056.pptx"],
  );
});

test("handles windows paths and deduplicates repeats", () => {
  const text =
    'deck: C:\\Users\\lance\\proj\\exports\\deck.pptx\nagain: C:\\Users\\lance\\proj\\exports\\deck.pptx';
  assert.deepEqual(extractExportedPptxPaths(text), [
    "C:\\Users\\lance\\proj\\exports\\deck.pptx",
  ]);
});

test("ignores bare extensions and non-pptx mentions", () => {
  assert.deepEqual(extractExportedPptxPaths({ content: "export .pptx template pptx" }), []);
});

test("only export-gated slides tools qualify for registration", () => {
  const base = { sessionId: "s1", args: {}, result: { content: "x.pptx" } };
  assert.ok(
    isSlidesExportResult({
      ...base,
      pluginId: "laboflow.ppt-master",
      toolName: "ppt_script",
      args: { script: "svg_to_pptx" },
    }),
  );
  // L2 gate: quality_checker runs ppt_script but must not register.
  assert.equal(
    isSlidesExportResult({
      ...base,
      pluginId: "laboflow.ppt-master",
      toolName: "ppt_script",
      args: { script: "quality_checker" },
    }),
    false,
  );
  // The removed L1 export must never come back as an artifact source.
  assert.equal(
    isSlidesExportResult({ ...base, pluginId: "laboflow.ppt-master", toolName: "slides_export" }),
    false,
  );
  assert.equal(
    isSlidesExportResult({
      ...base,
      pluginId: "pi.browser",
      toolName: "ppt_script",
      args: { script: "svg_to_pptx" },
    }),
    false,
  );
});

test("registers via host artifacts.record once per session+path", async () => {
  const calls = [];
  const host = {
    call: async (method, params) => {
      calls.push([method, params]);
      return { ok: true };
    },
  };
  const input = {
    pluginId: "laboflow.ppt-master",
    toolName: "ppt_script",
    sessionId: "sess1",
    turnId: "turn9",
    args: { script: "svg_to_pptx" },
    result: { content: "exports/deck.pptx" },
  };
  const seen = new Set();
  await maybeRegisterSlidesArtifact(host, input, seen);
  await maybeRegisterSlidesArtifact(host, input, seen);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "artifacts.record");
  assert.deepEqual(calls[0][1], {
    sessionId: "sess1",
    path: "exports/deck.pptx",
    op: "export",
    turnId: "turn9",
  });
  // No host or no session: silent no-op.
  await maybeRegisterSlidesArtifact(null, input, seen);
  await maybeRegisterSlidesArtifact(host, { ...input, sessionId: "" }, seen);
  assert.equal(calls.length, 1);
});
