import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PLUGIN_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "resources",
  "plugins",
  "laboflow.slides",
);

const readPlugin = (rel) => readFileSync(join(PLUGIN_ROOT, rel), "utf8");

test("manifest grants agent.prompt.inject so contributed skills actually load", () => {
  const manifest = JSON.parse(readPlugin("manifest.json"));
  // registerSkills skips every contributed skill without this permission, so a
  // skills contribution without the grant is always a config bug.
  assert.ok(
    manifest.permissions.includes("agent.prompt.inject"),
    "laboflow.slides declares contributes.skills but is missing agent.prompt.inject",
  );
  assert.ok(
    (manifest.contributes?.skills ?? []).length > 0,
    "skills contribution disappeared",
  );
});

test("getPluginDir decodes the module URL — %20 must not reach fs calls", () => {
  const main = readPlugin("main.js");
  // URL.pathname keeps percent-encoding; a repo path with spaces would break
  // every vendored-script and requirements lookup.
  assert.ok(
    main.includes("fileURLToPath(import.meta.url)"),
    "getPluginDir must decode via fileURLToPath",
  );
  assert.doesNotMatch(main, /new URL\("\.",\s*import\.meta\.url\)\.pathname/);
});

test("workbench init survives the absent t-noexports element", () => {
  const html = readPlugin(join("renderer", "workbench.html"));
  // #exports is empty until a project loads, so the element only exists after
  // the first load — an unguarded deref kills the whole init script.
  assert.doesNotMatch(
    html,
    /getElementById\("t-noexports"\)\s*\.\s*(textContent|innerHTML|append)/,
    "unguarded t-noexports deref at init bricks every workbench listener",
  );
});

test("confirm card re-fetches the pending stage on focus", () => {
  const html = readPlugin(join("renderer", "confirm-card.html"));
  // openPanel only focuses an already-open card; without this the card keeps
  // showing the previous stage until the user closes and reopens it.
  assert.match(html, /addEventListener\("visibilitychange"/);
  assert.match(html, /renderedPendingKey/);
  assert.match(html, /addEventListener\("focus"/);
});

test("panel pages define the theme token pair for both color schemes", () => {
  // The host injects no --pi-bg/--pi-fg into plugin pages. Without local
  // definitions the fallback pair (transparent body + #1f2328 text) sat
  // near-black text on the dark window background (#181818).
  for (const page of ["renderer/confirm-card.html", "renderer/workbench.html"]) {
    const html = readPlugin(page);
    assert.match(html, /--pi-bg:\s*#ffffff/, `${page}: light --pi-bg missing`);
    assert.match(html, /--pi-fg:\s*#1f2328/, `${page}: light --pi-fg missing`);
    assert.match(
      html,
      /prefers-color-scheme: dark[\s\S]*?--pi-bg:\s*#181818[\s\S]*?--pi-fg:\s*#e6e8eb/,
      `${page}: dark scheme tokens missing`,
    );
  }
});

test("disk recovery of pending stages is time-bounded, not a permanent fixture", () => {
  // Regression (LaboFlow): recoverPendingFromDisk re-pended every abandoned
  // "submitted" stage forever, so the workbench confirmation section always
  // showed something — the user wanted it strictly trigger-scoped. Live
  // submissions (ppt_stage_submit) recover regardless of age; disk recovery
  // only within the window.
  const mainSource = readPlugin("main.js");
  assert.match(mainSource, /PENDING_RECOVERY_WINDOW_MS\s*=/);
  assert.match(
    mainSource,
    /Date\.now\(\) - submittedAt > PENDING_RECOVERY_WINDOW_MS/,
    "recovery must skip submissions older than the window",
  );
});
