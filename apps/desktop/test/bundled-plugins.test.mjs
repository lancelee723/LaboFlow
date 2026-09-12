import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * Bundled first-party plugins (ADR 0104).
 *
 * The point of shipping Files as a plugin rather than host code is that it
 * proves the public contribution channel is sufficient. These assertions guard
 * that property: the manifest must be an ordinary one, the plugin must reach
 * the panel through `contributes.views`, and it must not depend on anything a
 * third-party plugin could not also declare.
 */

const read = (path) => readFileSync(resolve(path), "utf8");
const manifest = JSON.parse(read("resources/plugins/pi.files/manifest.json"));
const view = read("resources/plugins/pi.files/views/tree.html");
const panelSource = read("src/components/workpanel/WorkPanel.tsx");
const hostProcessSource = read("electron/main/host-process.ts");
const packageJson = JSON.parse(read("package.json"));

test("Files ships as an ordinary plugin, not a privileged one", () => {
  assert.equal(manifest.id, "pi.files");
  assert.deepEqual(manifest.contributes.views.map((v) => v.id), ["tree"]);
  // Exactly the permissions a third party would have to declare for the same
  // capability — nothing host-only.
  assert.deepEqual([...manifest.permissions].sort(), ["fs.read", "ui.view"]);
  assert.equal(manifest.fs.read.root, "workspace");
  assert.deepEqual(manifest.fs.read.scope, ["**"]);
  // A localized title, because the panel menu shows it to the user.
  assert.equal(typeof manifest.contributes.views[0].title.en, "string");
  assert.equal(typeof manifest.contributes.views[0].title["zh-CN"], "string");
});

test("the Files view uses only public bridge channels", () => {
  for (const channel of [
    "fs.list",
    "fs.readPreview",
    "fs.glob",
    "fs.openDefault",
    "fs.reveal",
    "workspace.get",
    "app.getAppearance",
  ]) {
    assert.ok(
      view.includes(`"${channel}"`),
      `expected the view to call ${channel} over the bridge`,
    );
  }
  // No Node, no Electron, no host internals: it is a sandboxed page.
  assert.doesNotMatch(view, /require\(|import\s+.*from\s+["']node:|ipcRenderer/);
  // The titlebar height is read, not hard-coded, so the same file also works
  // in a detached panel window.
  assert.match(view, /var\(--pi-plugin-titlebar-height, 0px\)/);
  assert.match(view, /meta name="pi-plugin-chrome" content="v2"/);
});

test("the Files view keeps the former browser workflow while staying plugin-owned", () => {
  // The old host FilesTab established the useful interaction contract: a
  // lazy tree opens a focused viewer, and Back returns to the same selection.
  // Keep those affordances in the isolated plugin page so moving ownership did
  // not make the feature less capable.
  for (const marker of [
    'id="refresh"',
    'id="back"',
    'id="viewer-body"',
    'id="reveal"',
    'id="open"',
    'id="search"',
    'role="tree"',
    'role", "treeitem"',
    'aria-expanded',
    'MAX_LINES = 5000',
    'prefers-reduced-motion: reduce',
  ]) {
    assert.ok(view.includes(marker), `expected Files view marker: ${marker}`);
  }
  assert.match(view, /fs\.readPreview/);
  assert.match(view, /fs\.openDefault/);
  assert.match(view, /fs\.reveal/);
  assert.match(view, /fs\.glob/);
  assert.match(view, /workspace:changed/);
  assert.match(view, /kind === "image"/);
  assert.match(view, /kind === "tooLarge"/);
  assert.match(view, /content\.includes\("\\0"\)/);
  assert.match(view, /appearance:changed/);
  assert.match(view, /locale.*startsWith\("zh"\)/);
  assert.match(view, /retry/);
  assert.match(view, /refreshing/);
  assert.match(view, /mini-spinner/);
  assert.match(view, /aria-busy/);
  assert.match(view, /direction:\s*rtl/);
  assert.match(view, /globFromQuery/);
  assert.doesNotMatch(view, /setInterval/);
  assert.doesNotMatch(view, /SPLIT_MIN|app\.split/);
  // The main app is intentionally monochrome; the bundled view must not
  // drift back to the blue accent it used before joining the host palette.
  assert.doesNotMatch(view, /#7aa2f7|#2563eb|#22c55e/);
  // The plugin cannot reach host-only reveal or renderer APIs. Keeping this
  // page on the public bridge is part of the bundled-plugin contract.
  assert.doesNotMatch(view, /fsReveal|ipcRenderer|require\(/);
});

test("the host no longer offers Files or Browser as built-in tools", () => {
  assert.doesNotMatch(panelSource, /const HEADER_TOOLS/);
  assert.doesNotMatch(panelSource, /kind: "browser"/);
  assert.doesNotMatch(panelSource, /kind: "terminal"/);
  // Review and file remain artifact/resource surfaces the conversation opens.
  assert.match(panelSource, /activeTab\?\.kind === "file"/);
  assert.match(panelSource, /activeTab\?\.kind === "review"/);
});

test("Review still opens itself from workspace edit artifacts", () => {
  // Removing the launcher entry must not remove the way Review appears at all.
  const storeSource = read("src/stores/app-store.ts");
  assert.match(storeSource, /shouldOpenReviewArtifact\(\{/);
  assert.match(storeSource, /toolWorkPanelTab\("review"\)/);
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

test("Advisor ships as an ordinary plugin over the public complete APIs", () => {
  const advisorManifest = JSON.parse(read("resources/plugins/pi.advisor/manifest.json"));
  const advisorMain = read("resources/plugins/pi.advisor/main.js");
  const advisorPanel = read("resources/plugins/pi.advisor/renderer/index.html");
  assert.equal(advisorManifest.id, "pi.advisor");
  assert.equal(advisorManifest.enabledByDefault, false);
  assert.deepEqual(
    [...advisorManifest.permissions].sort(),
    [
      "agent.complete",
      "agent.prompt.inject",
      "agent.tool.register",
      "models.list",
      "session.read",
      "ui.panel",
    ],
  );
  assert.match(advisorMain, /pi\.agent\.complete/);
  assert.match(advisorMain, /includeSessionContext:\s*true/);
  assert.match(advisorMain, /pi\.session\.getLlmContext|pi\.models\.list/);
  assert.match(advisorPanel, /pluginBridge/);
  assert.match(advisorPanel, /advisor\.set/);
  assert.doesNotMatch(advisorMain, /apiKey|safeStorage|net\.fetch/);
  assert.doesNotMatch(advisorPanel, /require\(|ipcRenderer/);
});

/**
 * Token Insights ships bundled so the usage stats page has its live fact cube
 * on a fresh machine (the page renders the plugin's aggregation, scoped to
 * this app's "pi-desktop" source, and falls back to host history when the
 * plugin is absent). Vendored from the official PI-Desktop market plugin.
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
