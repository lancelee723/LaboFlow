import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { applyBundle } = await import(join(root, "scripts/fetch-bundled-plugins.mjs"));

function makeSource(id, version) {
  const dir = mkdtempSync(join(tmpdir(), "bund-src-"));
  mkdirSync(join(dir, "renderer"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, version }));
  writeFileSync(join(dir, "renderer/x.html"), "<html/>");
  const wh = join(dir, "wheelhouse", `${platform()}-${arch()}`);
  mkdirSync(wh, { recursive: true });
  writeFileSync(join(wh, "dummy.whl"), "wheel");
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
test("applyBundle refuses a source without the offline wheelhouse", async () => {
  const src = makeSource("laboflow.ppt-master", "4.0.0");
  rmSync(join(src, "wheelhouse"), { recursive: true, force: true });
  const dest = mkdtempSync(join(tmpdir(), "bund-dest-"));
  const lock = { "laboflow.ppt-master": { version: "4.0.0", source: src } };
  await assert.rejects(
    () => applyBundle({ lock, pluginsDir: dest, expectedId: "laboflow.ppt-master" }),
    /wheelhouse missing/,
  );
  rmSync(src, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true });
});
test("applyBundle excludes repo-hygiene files from the copied plugin", async () => {
  const src = makeSource("laboflow.ppt-master", "4.0.0");
  mkdirSync(join(src, "test"), { recursive: true });
  writeFileSync(join(src, "test/x.test.mjs"), "export {};\n");
  writeFileSync(join(src, "README.md"), "readme\n");
  writeFileSync(join(src, "AGENTS.md"), "agents\n");
  writeFileSync(join(src, "PROVENANCE.md"), "provenance\n");
  const dest = mkdtempSync(join(tmpdir(), "bund-dest-"));
  const lock = { "laboflow.ppt-master": { version: "4.0.0", source: src } };
  const report = await applyBundle({ lock, pluginsDir: dest, expectedId: "laboflow.ppt-master" });
  assert.equal(report.copied, true);
  const copied = join(dest, "laboflow.ppt-master");
  assert.ok(!existsSync(join(copied, "test")), "test/ dir must not ship");
  assert.ok(!existsSync(join(copied, "README.md")), "README.md must not ship");
  assert.ok(!existsSync(join(copied, "AGENTS.md")), "AGENTS.md must not ship");
  assert.ok(!existsSync(join(copied, "PROVENANCE.md")), "PROVENANCE.md must not ship");
  assert.ok(existsSync(join(copied, "manifest.json")), "manifest.json must ship");
  assert.ok(existsSync(join(copied, "renderer/x.html")), "renderer must ship");
  rmSync(src, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true });
});
