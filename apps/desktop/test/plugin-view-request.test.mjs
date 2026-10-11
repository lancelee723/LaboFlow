import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { resolveOwnPluginView } = await import("../electron/main/plugin-view-request.ts");

const views = [{ id: "workbench", entry: "renderer/workbench.html" }];
const perms = (p) => new Set(p);

test("resolves a declared view with an existing entry", () => {
  const dir = mkdtmp();
  writeFileSync(join(dir, "renderer/workbench.html"), "<html/>");
  const r = resolveOwnPluginView({
    permissions: perms(["ui.view"]),
    views,
    pluginPath: dir,
    viewId: "workbench",
  });
  assert.equal(r.ok, true);
  assert.equal(r.htmlPath, join(dir, "renderer/workbench.html"));
  rm(dir);
});

test("denies without ui.view permission", () => {
  const r = resolveOwnPluginView({
    permissions: perms([]),
    views,
    pluginPath: "/x",
    viewId: "workbench",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "PERMISSION");
});

test("rejects an undeclared view id", () => {
  const r = resolveOwnPluginView({
    permissions: perms(["ui.view"]),
    views,
    pluginPath: "/x",
    viewId: "other",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "UNKNOWN_VIEW");
});

test("rejects a declared view whose entry file is missing", () => {
  const r = resolveOwnPluginView({
    permissions: perms(["ui.view"]),
    views,
    pluginPath: "/x",
    viewId: "workbench",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "ENTRY_MISSING");
});

function mkdtmp() {
  const d = join(tmpdir(), `pvr-${Date.now()}-${Math.random()}`);
  mkdirSync(join(d, "renderer"), { recursive: true });
  return d;
}
function rm(d) {
  rmSync(d, { recursive: true, force: true });
}
