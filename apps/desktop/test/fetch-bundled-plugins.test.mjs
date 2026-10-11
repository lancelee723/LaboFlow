import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { applyBundle } = await import(join(root, "scripts/fetch-bundled-plugins.mjs"));

function makeSource(id, version) {
  const dir = mkdtempSync(join(tmpdir(), "bund-src-"));
  mkdirSync(join(dir, "renderer"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, version }));
  writeFileSync(join(dir, "renderer/x.html"), "<html/>");
  return dir;
}
test("applyBundle copies a local source and validates id+version", async () => {
  const src = makeSource("laboflow.ppt-master", "4.0.0");
  const dest = mkdtempSync(join(tmpdir(), "bund-dest-"));
  const lock = { "laboflow.ppt-master": { version: "4.0.0", source: src } };
  const report = await applyBundle({ lock, pluginsDir: dest, expectedId: "laboflow.ppt-master" });
  assert.equal(report.copied, true);
  assert.ok(existsSync(join(dest, "laboflow.ppt-master", "renderer/x.html")));
  rmSync(src, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true });
});
test("applyBundle refuses a version mismatch", async () => {
  const src = makeSource("laboflow.ppt-master", "3.0.0");
  const dest = mkdtempSync(join(tmpdir(), "bund-dest-"));
  const lock = { "laboflow.ppt-master": { version: "4.0.0", source: src } };
  await assert.rejects(() => applyBundle({ lock, pluginsDir: dest, expectedId: "laboflow.ppt-master" }), /version/i);
  rmSync(src, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true });
});
