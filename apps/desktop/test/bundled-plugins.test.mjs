import { readStoreSourceSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

/**
 * Bundled plugins (ADR 0104, ADR 0241).
 *
 * The point of shipping a panel surface as a plugin rather than host code is
 * that it proves the public contribution channel is sufficient. The file view
 * is now a vendored third-party plugin — the artifact the marketplace also
 * publishes — so these assertions guard both halves of that claim: it must be
 * an ordinary plugin any third party could have written, and the copy in this
 * repository must stay traceable to the release it came from.
 */

const read = (path) => readFileSync(resolve(path), "utf8");
const FILE_MANAGER = "resources/plugins/pi.file-manager";
const manifest = JSON.parse(read(`${FILE_MANAGER}/manifest.json`));
const view = read(`${FILE_MANAGER}/views/index.html`);
const viewBundle = read(`${FILE_MANAGER}/views/assets/index.js`);
const upstream = read(`${FILE_MANAGER}/UPSTREAM.md`);
const panelSource = read("src/components/workpanel/WorkPanel.tsx");
const hostProcessSource = read("electron/main/host-process.ts");
const packageJson = JSON.parse(read("package.json"));

test("the file view ships as an ordinary plugin, not a privileged one", () => {
  assert.equal(manifest.id, "pi.file-manager");
  assert.deepEqual(manifest.contributes.views.map((v) => v.id), ["manager"]);
  // Exactly the permissions a third party would have to declare for the same
  // capability — nothing host-only.
  assert.deepEqual([...manifest.permissions].sort(), ["fs.read", "ui.view"]);
  assert.equal(manifest.fs.read.root, "workspace");
  assert.deepEqual(manifest.fs.read.scope, ["**"]);
  // A localized title, because the panel menu shows it to the user.
  assert.equal(typeof manifest.contributes.views[0].title.en, "string");
  assert.equal(typeof manifest.contributes.views[0].title["zh-CN"], "string");
  // Vendored from an MIT-licensed repository, so the license travels with it.
  assert.equal(manifest.license, "MIT");
  assert.ok(existsSync(resolve(`${FILE_MANAGER}/LICENSE`)));
});

test("the file view is a sandboxed page over the public bridge", () => {
  // The two host-mediated actions, and the plugin's own panel channels. All of
  // them are public SDK surface: the page can reach nothing else.
  for (const channel of ["fs.openDefault", "fs.reveal", "fm.read", "fm.write"]) {
    assert.ok(
      viewBundle.includes(channel),
      `expected the view to call ${channel} over the bridge`,
    );
  }
  assert.match(viewBundle, /pluginBridge/);
  // No Node, no Electron, no host internals: it is a sandboxed page.
  assert.doesNotMatch(view, /require\(|import\s+.*from\s+["']node:|ipcRenderer/);
  assert.doesNotMatch(viewBundle, /require\(|ipcRenderer/);
  // The titlebar height is read, not hard-coded, so the same file also works
  // in a detached panel window.
  assert.match(viewBundle, /var\(--pi-plugin-titlebar-height, 0px\)/);
  assert.match(view, /meta name="pi-plugin-chrome" content="v2"/);
});

test("the vendored copy stays traceable to its upstream release", () => {
  assert.match(upstream, /github\.com\/Tioit-Wang\/pi-desktop-plugin-file-manager/);
  assert.match(upstream, /d36ebe9f7fb82ee71e87670b0a65403660b18a00/);
  // The version the manifest carries and the tag the record names are the same
  // release: a bump that skips the other one is a sync mistake.
  const tag = upstream.match(/`v(\d+\.\d+\.\d+)`/);
  assert.ok(tag, "UPSTREAM.md must name the vendored tag");
  assert.equal(manifest.version, tag[1]);
  // Every file the vendored copy does not patch still hashes to the recorded
  // value, so a silent edit cannot pass as the released artifact.
  for (const file of [
    "main.js",
    "README.md",
    "views/index.html",
    "views/assets/index.js",
  ]) {
    const hash = createHash("sha256")
      .update(readFileSync(resolve(`${FILE_MANAGER}/${file}`)))
      .digest("hex");
    assert.ok(
      upstream.includes(hash),
      `expected UPSTREAM.md to record the ${file} checksum`,
    );
  }
});

test("the host no longer bundles the old Files plugin", () => {
  // Its view is what this plugin replaced. host-core drops the stale registry
  // row through `drop_missing_builtin` on the first launch after the swap.
  assert.equal(existsSync(resolve("resources/plugins/pi.files")), false);
});

test("the host no longer offers Files or Browser as built-in tools", () => {
  assert.doesNotMatch(panelSource, /const HEADER_TOOLS/);
  assert.doesNotMatch(panelSource, /kind: "browser"/);
  assert.doesNotMatch(panelSource, /kind: "terminal"/);
  // Review and file remain artifact/resource surfaces the conversation opens.
  assert.match(panelSource, /activeTab\?\.kind === "file"/);
  assert.match(panelSource, /activeTab\?\.kind === "review"/);
});

test("Review opens only from an explicit user action", () => {
  // The New launcher row and the viewport-fixed toggle are the only ways in,
  // so a workspace edit can no longer reveal or activate Review by itself.
  const storeSource = readStoreSourceSync();
  assert.doesNotMatch(storeSource, /shouldOpenReviewArtifact/);
  assert.doesNotMatch(storeSource, /toolWorkPanelTab\("review"\)/);
  assert.match(panelSource, /toolWorkPanelTab\("review"\)/);
});

test("Browser ships as an ordinary plugin over the public CDP API", () => {
  const browserManifest = JSON.parse(read("resources/plugins/pi.browser/manifest.json"));
  const browserMain = read("resources/plugins/pi.browser/main.js");
  const browserView = read("resources/plugins/pi.browser/views/browser.html");
  assert.equal(browserManifest.id, "pi.browser");
  assert.deepEqual(browserManifest.contributes.views.map((v) => v.id), ["browser"]);
  assert.deepEqual(
    [...browserManifest.permissions].sort(),
    ["agent.tool.register", "browser.cdp", "ui.view"],
  );
  assert.equal(typeof browserManifest.contributes.views[0].title.en, "string");
  assert.equal(typeof browserManifest.contributes.views[0].title["zh-CN"], "string");
  assert.match(browserMain, /pi\.agent\.registerTool/);
  assert.match(browserMain, /pi\.browser\.(navigate|snapshot|cdp)/);
  assert.match(browserView, /pluginBridge/);
  assert.match(browserView, /browser\.setBounds/);
  assert.doesNotMatch(browserView, /require\(|ipcRenderer|webview/);
});

test("Browser declares plan-safe actions for Plan-mode URL inspection (ADR 0211)", () => {
  const browserMain = read("resources/plugins/pi.browser/main.js");
  // The planSafeActions list must be declared on the registered tool.
  assert.match(browserMain, /planSafeActions\s*:\s*PLAN_SAFE_ACTIONS/);
  // The list itself must declare the four read-only actions the user needs.
  assert.match(
    browserMain,
    /PLAN_SAFE_ACTIONS\s*=\s*\[\s*"navigate"\s*,\s*"snapshot"\s*,\s*"screenshot"\s*,\s*"console"\s*\]/,
  );
  // The mutating actions must NOT appear in PLAN_SAFE_ACTIONS, otherwise
  // Plan mode would be able to click/fill/evaluate arbitrary pages.
  const planSafeMatch = browserMain.match(/PLAN_SAFE_ACTIONS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(planSafeMatch, "PLAN_SAFE_ACTIONS array must exist");
  for (const unsafe of ["click", "fill", "evaluate", "cdp"]) {
    assert.doesNotMatch(
      planSafeMatch[1],
      new RegExp('"' + unsafe + '"'),
      `mutating action ${unsafe} must not appear in PLAN_SAFE_ACTIONS`,
    );
  }
});


test("Advisor is temporarily not bundled", () => {
  assert.equal(existsSync(resolve("resources/plugins/pi.advisor")), false);
});

/**
 * Token Insights ships bundled so the usage stats page has its live fact cube
 * on a fresh machine (the page renders the plugin's aggregation, scoped to
 * this app's "pi-desktop" source, and falls back to host history when the
 * plugin is absent). Vendored from the official LaboFlow market plugin.
 */
test("Token Insights ships as an ordinary bundled plugin", () => {
  const insightsManifest = JSON.parse(
    read("resources/plugins/pi.token-insights/manifest.json"),
  );
  const insightsMain = read("resources/plugins/pi.token-insights/main.js");
  const insightsPanel = read(
    "resources/plugins/pi.token-insights/renderer/panel.js",
  );
  assert.equal(insightsManifest.id, "pi.token-insights");
  // Enabled by default so the usage stats page finds its cube out of the box.
  assert.equal(insightsManifest.enabledByDefault ?? true, true);
  assert.deepEqual([...insightsManifest.permissions].sort(), [
    "agent.tool.register",
    "ui.panel",
  ]);
  // The agent tool is the plugin's documented aggregation surface.
  assert.deepEqual(
    insightsManifest.contributes.agentTools.map((tool) => tool.name),
    ["token_usage_summary"],
  );
  assert.equal(insightsManifest.ui.panel, "renderer/index.html");
  // The plugin is CommonJS; without this shim Node walks up to
  // apps/desktop/package.json (type: module) and main.js dies with
  // "require is not defined in ES module scope" at load.
  const insightsPkg = JSON.parse(
    read("resources/plugins/pi.token-insights/package.json"),
  );
  assert.equal(insightsPkg.type, "commonjs");
  // Reads local metadata only, exactly like every third-party plugin could.
  assert.match(insightsMain, /pi\.plugin\.getDataPath/);
  assert.match(insightsPanel, /window\.pluginBridge/);
  assert.doesNotMatch(insightsPanel, /require\(|ipcRenderer|webview/);
});

/**
 * LaboFlow Slides (module 06): L1 pptxgenjs baseline + L2 vendored PPT-Master.
 *
 * The L2 channel failed acceptance once (tools defined but never registered,
 * vendored SKILL.md invisible to the agent, stale CLI arg contracts). These
 * assertions pin the rebuild contract from
 * docs/laboflow/phase5/06-ppt-assistant/PPT-MASTER-PLUGIN-DEVPLAN.md:
 * every L2 tool the runtime registers must be declared, the PPT-Master skill
 * corpus must be reachable through contributes.skills, and the vendored tree
 * must stay AGPL-clean and pyc-free.
 */
test("Slides ships the L1+L2 tool surface it registers", () => {
  const slidesManifest = JSON.parse(read("resources/plugins/laboflow.slides/manifest.json"));
  const slidesMain = read("resources/plugins/laboflow.slides/main.js");
  assert.equal(slidesManifest.id, "laboflow.slides");
  const declaredTools = slidesManifest.contributes.agentTools.map((t) => t.name);
  for (const tool of [
    "slides_plan",
    "slides_export",
    "ppt_master_status",
    "ppt_master_setup",
    "ppt_job_status",
    "ppt_read_doc",
    "ppt_script",
    "ppt_stage_submit",
    "ppt_stage_status",
  ]) {
    assert.ok(declaredTools.includes(tool), `manifest must declare ${tool}`);
    assert.ok(
      new RegExp(`name:\\s*"${tool}"`).test(slidesMain),
      `main.js must register ${tool}`,
    );
  }
  // The old dead-code path (defined but never registered) must stay gone.
  assert.doesNotMatch(slidesMain, /registerL2Tools/);
  assert.match(slidesMain, /pi\.agent\.registerTool/);
  // Phase B/C surfaces: the confirm card is a user panel, the workbench a
  // docked view, and the palette entry only OPENS the card (confirmation is
  // never a one-keystroke action).
  assert.equal(slidesManifest.ui.panel, "renderer/confirm-card.html");
  assert.deepEqual(slidesManifest.contributes.views.map((v) => v.id), ["workbench"]);
  assert.ok(existsSync(resolve("resources/plugins/laboflow.slides/renderer/workbench.html")));
  assert.deepEqual(slidesManifest.contributes.commands.map((c) => c.id), ["openConfirmCard"]);
  for (const permission of ["ui.panel", "ui.view", "notify"]) {
    assert.ok(slidesManifest.permissions.includes(permission), `permission needed: ${permission}`);
  }
  // Sandbox hygiene for both renderer pages.
  for (const page of ["renderer/confirm-card.html", "renderer/workbench.html"]) {
    const source = read(`resources/plugins/laboflow.slides/${page}`);
    assert.match(source, /meta name="pi-plugin-chrome" content="v2"/);
    assert.doesNotMatch(source, /require\(|ipcRenderer|webview/);
  }
});

test("Slides exposes the PPT-Master skill corpus to the agent", () => {
  const slidesManifest = JSON.parse(read("resources/plugins/laboflow.slides/manifest.json"));
  const skills = slidesManifest.contributes.skills.map((s) =>
    typeof s === "string" ? s : s.path,
  );
  assert.ok(skills.includes("./skills/slides.md"), "L1 workflow skill must stay");
  assert.ok(
    skills.includes("./skills/ppt-master.md"),
    "vendored PPT-Master needs its thin-shell skill or the agent cannot route to L2",
  );
  // Frontmatter contract (Pi skills spec): name + description, description<=240.
  const skill = read("resources/plugins/laboflow.slides/skills/ppt-master.md");
  assert.match(skill, /^---\nname:\s*\S+[\s\S]*^---/m);
  const desc = skill.match(/^description:\s*>?-?\s*\n?([\s\S]*?)(?=^\w|^---)/m);
  const descText = desc ? desc[1].replace(/\s+/g, " ").trim() : "";
  assert.ok(
    descText.length > 0 && descText.length <= 240,
    `ppt-master skill description must be 1..240 chars, got ${descText.length}`,
  );
  assert.ok(skill.length <= 128 * 1024, "skill body must stay under 128 KiB");
});

test("Slides vendored PPT-Master stays complete, pinned and AGPL-free", async () => {
  const vendorRoot = "resources/plugins/laboflow.slides/vendored/ppt-master";
  for (const rel of [
    "SKILL.md",
    "VENDOR_VERSION",
    "LICENSE",
    "SPONSORS.md",
    "requirements-laboflow.txt",
    "workflows/routing.md",
    "workflows/generate-pptx.md",
    "scripts/attribution_guard.py",
    "scripts/laboflow_guard.py",
    "scripts/svg_quality_checker.py",
    "scripts/finalize_svg.py",
    "scripts/svg_to_pptx.py",
  ]) {
    assert.ok(existsSync(resolve(`${vendorRoot}/${rel}`)), `vendored file missing: ${rel}`);
  }
  // The upstream requirements (PyMuPDF/edge-tts/ebooklib inside) must never be
  // what gets installed; only the trimmed MIT list may be.
  const req = read(`${vendorRoot}/requirements-laboflow.txt`);
  for (const banned of ["PyMuPDF", "pandoc", "edge-tts", "ebooklib", "flask"]) {
    assert.doesNotMatch(req, new RegExp(`^${banned}`, "m"), `${banned} must stay out of the trimmed requirements`);
  }
  // Running the vendored python regenerates bytecode caches on disk (the
  // wrapper sets PYTHONDONTWRITEBYTECODE=1 but direct runs do not), so the
  // real invariant is repository hygiene: none may be tracked in git.
  const { execFileSync } = await import("node:child_process");
  const repoRoot = resolve("../..");
  const tracked = execFileSync(
    "git",
    ["ls-files", "apps/desktop/resources/plugins/laboflow.slides/**/*.pyc"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  ).split("\n").filter(Boolean);
  assert.deepEqual(tracked, [], "no .pyc files may be tracked in git");
  // Packaging footprint baseline (DEVPLAN G): the vendored corpus dominates
  // the installer delta. Guard the ceiling so a careless vendor refresh can
  // not silently blow up download sizes.
  const du = (dir) => {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) total += du(full);
      else total += statSync(full).size;
    }
    return total;
  };
  const pluginBytes = du(resolve("resources/plugins/laboflow.slides"));
  assert.ok(
    pluginBytes <= 75 * 1024 * 1024,
    `plugin footprint ${(pluginBytes / 1048576).toFixed(1)} MiB exceeds the 75 MiB packaging ceiling`,
  );
});

test("bundled plugins are packaged and located at runtime", () => {
  assert.ok(
    packageJson.build.extraResources.some(
      (entry) => entry.from === "resources/plugins" && entry.to === "plugins",
    ),
    "resources/plugins must be copied outside the asar",
  );
  // host-core cannot know whether it runs from resources/ or a checkout, so
  // Electron resolves the directory and hands it over.
  assert.match(hostProcessSource, /function resolveBuiltinPluginsDir\(\)/);
  assert.match(hostProcessSource, /PI_DESKTOP_BUILTIN_PLUGINS_DIR/);
  assert.match(hostProcessSource, /join\(process\.resourcesPath \|\| "", "plugins"\)/);
});
