#!/usr/bin/env node
/**
 * LaboFlow Slides — protocol-level session replay (DEVPLAN §6.3 S10/S2/S4/S8
 * headless equivalent; no model key needed).
 *
 * The real host-core is spawned against the repo's bundled-plugins dir, the
 * laboflow.slides plugin is discovered and enabled through the real registry,
 * and the real `tools.execute` → `plugins.execute` dispatch path is exercised.
 * This harness plays the Electron plugin-host role: it imports the plugin's
 * actual main.js under a minimal `pi` global and routes the host's
 * `plugins.execute` notifications to the registered tool implementations, so
 * every tool runs for real (real venv, real upstream scripts, real state
 * machine) — only the chat-model intelligence is scripted, following the
 * ppt-master skill preamble step by step.
 *
 * Env: optional PI_DESKTOP_SLIDES_DATA_DIR to pin the plugin data dir
 * (defaults to a fresh venv build, ~20s with uv).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const hostBin = process.env.PI_DESKTOP_HOST_BIN
  ? resolve(process.env.PI_DESKTOP_HOST_BIN)
  : join(root, "target/debug/pi-desktop-host-core");
const { PROTOCOL_VERSION } = await import(
  pathToFileURL(join(root, "packages/shared/dist/protocol.js")).href
);

const PLUGIN_DIR = join(root, "apps/desktop/resources/plugins/laboflow.slides");
const pluginDataDir =
  process.env.PI_DESKTOP_SLIDES_DATA_DIR || join(tmpdir(), "ppt-session-data-" + randomUUID().slice(0, 8));
mkdirSync(join(pluginDataDir, "ppt-runtime"), { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "ppt-session-host-"));
const workspace = mkdtempSync(join(tmpdir(), "ppt-session-ws-"));
mkdirSync(join(workspace, "projects"), { recursive: true });

const results = [];
const record = (id, ok, note = "") => {
  results.push({ id, ok, note: String(note).slice(0, 160) });
  console.log(`${ok ? "✔" : "✖"} ${id}${note ? ` — ${note}` : ""}`);
};

// ── minimal `pi` global: the Electron plugin-host stand-in ────────────────────
const registeredTools = new Map();
globalThis.pi = {
  agent: {
    registerTool: (tool) => {
      registeredTools.set(tool.name, tool);
      return Promise.resolve();
    },
  },
  plugin: {
    getSettings: async () => ({ accentColor: "1F4E79", outputDir: "slides", pipMirror: "default" }),
    getDataPath: async () => pluginDataDir,
  },
  workspace: { get: async () => ({ path: workspace, name: "e2e" }) },
  commands: { register: async () => {} },
  ui: {
    openPanel: async () => {},
    showToast: async () => {},
    showNativeNotification: async () => {},
  },
  log: () => {},
};

const pluginModule = await import(pathToFileURL(join(PLUGIN_DIR, "main.js")).href);
await pluginModule.onLoad();
const toolNameFor = (name) => `plugin_laboflow_slides_${name}`;

// ── host-core over stdio ──────────────────────────────────────────────────────
class Host {
  constructor(bin, dir) {
    this.child = spawn(bin, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_DESKTOP_DATA_DIR: dir,
        PI_DESKTOP_BUILTIN_PLUGINS_DIR: join(root, "apps/desktop/resources/plugins"),
      },
    });
    this.pending = new Map();
    this.notifications = [];
    this.seenExecutions = new Set();
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id != null) {
        const p = this.pending.get(String(msg.id));
        if (p) {
          this.pending.delete(String(msg.id));
          if (msg.error) p.reject(msg.error);
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        this.notifications.push(msg);
      }
    });
    this.child.stderr.on("data", () => {});
  }
  call(method, params = {}, timeoutMs = 60_000) {
    const id = randomUUID();
    return new Promise((resolve2, reject) => {
      this.pending.set(id, { resolve: resolve2, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, timeoutMs);
    });
  }
  async waitForPluginExec(toolName, timeoutMs = 180_000) {
    const started = Date.now();
    for (;;) {
      const note = [...this.notifications]
        .reverse()
        .find(
          (n) =>
            n.method === "plugins.execute" &&
            n.params?.toolName === toolName &&
            !this.seenExecutions.has(n.params.executionId),
        );
      if (note) {
        this.seenExecutions.add(note.params.executionId);
        return note;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`no plugins.execute for ${toolName}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  async autoApprove(toolCallId, allow = true) {
    for (let i = 0; i < 100; i++) {
      const req = this.notifications.find(
        (n) => n.method === "permissions.request" && n.params?.toolCallId === toolCallId,
      );
      if (req) {
        await this.call("permissions.resolve", { requestId: req.params.requestId, allow });
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }
  async dispose() {
    const exited = new Promise((r) => this.child.once("exit", r));
    this.child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}

async function callPluginTool(host, sessionId, name, args) {
  const toolName = toolNameFor(name);
  const toolCallId = randomUUID();
  const dispatchP = host.call("tools.execute", {
    sessionId,
    toolCallId,
    toolName,
    declaredRisk: "low",
    args,
    mode: "agent",
  }).catch((error) => ({ __rejected: true, error }));
  const note = await host.waitForPluginExec(toolName);
  await host.autoApprove(toolCallId, true);
  const tool = registeredTools.get(name);
  if (!tool) throw new Error(`plugin did not register ${name}`);
  let ok = true;
  let payload;
  try {
    payload = await tool.execute(args ?? {});
  } catch (error) {
    ok = false;
    payload = { error: String(error?.message ?? error) };
  }
  await host.call("plugins.resolveExecution", {
    executionId: note.params.executionId,
    ok,
    content: payload ?? {},
  });
  const dispatched = await dispatchP;
  if (dispatched?.__rejected) throw new Error(`tools.execute rejected: ${JSON.stringify(dispatched.error)}`);
  return { dispatched, payload };
}

async function main() {
  if (!existsSync(hostBin)) {
    console.error(`missing host bin: ${hostBin} (build with cargo build -p host-core)`);
    process.exit(1);
  }
  const host = new Host(hostBin, dataDir);
  try {
    await host.call("app.handshake", { protocolVersion: PROTOCOL_VERSION });

    // 1. Bundled discovery + enablement through the real registry.
    const plugins = await host.call("plugins.list");
    const slides = (plugins.plugins ?? []).find((p) => p.id === "laboflow.slides");
    record("S10-01-plugin-discovered", !!slides, slides ? `enabled=${slides.enabled}` : "missing");

    const session = await host.call("session.create", { title: "S10 replay", projectPath: workspace });
    const sessionId = session.session?.id ?? session.id;

    // 2. Skill preamble step 1: status must hand over paths + ready state.
    const status = await callPluginTool(host, sessionId, "ppt_master_status", {});
    const statusBody =
      status.dispatched?.content?.details ?? status.payload?.details ?? status.payload ?? {};
    if (!statusBody.stage) {
      console.error("status debug:", JSON.stringify(status).slice(0, 400));
    }
    record(
      "S10-02-runtime-status",
      Boolean(statusBody.skillDir && statusBody.pythonPath) &&
        ["ready", "venv-missing"].includes(statusBody.stage),
      `stage=${statusBody.stage}`,
    );

    // 3. Corpus bridge: the agent reads the routing authority.
    const doc = await callPluginTool(host, sessionId, "ppt_read_doc", { path: "workflows/routing.md" });
    record("S10-03-corpus-read", String(doc.payload?.content ?? doc.payload ?? "").includes("oute"), "routing.md");

    // 4. Project scaffolding inside the workspace (never the skill dir).
    const init = await callPluginTool(host, sessionId, "ppt_script", {
      script: "project_manager",
      args: { subcommand: "init", name: "s10_replay", dir: join(workspace, "projects"), format: "ppt169" },
    });
    const projectsRoot = join(workspace, "projects");
    const created = existsSync(projectsRoot) ? readdirSync(projectsRoot) : [];
    record(
      "S10-04-project-init",
      created.length === 1 && existsSync(join(projectsRoot, created[0], "svg_output")),
      created.join(","),
    );
    if (created.length !== 1) {
      console.error("init did not scaffold exactly one project — aborting the replay");
      process.exitCode = 1;
      return;
    }
    const projectDir = join(projectsRoot, created[0]);

    // 5. Stage-2 submission opens the user gate.
    const submit = await callPluginTool(host, sessionId, "ppt_stage_submit", {
      projectDir,
      stage: "stage2",
      recommendations: {
        directions: [
          { name: "deep consulting blue", palette: ["#051C2C", "#2251FF"] },
          { name: "warm editorial", palette: ["#F5EFE6", "#B4451F"] },
          { name: "dark tech", palette: ["#0B1220", "#22D3EE"] },
        ],
        page_count: 3,
      },
    });
    const stateFile = join(projectDir, "laboflow", "pipeline-state.json");
    const stateAfterSubmit = JSON.parse(readFileSync(stateFile, "utf8"));
    record(
      "S10-05-stage2-submitted",
      stateAfterSubmit.stages.stage2.status === "submitted" && existsSync(join(projectDir, "confirm_ui", "recommendations.stage2.json")),
      "recommendations written in upstream format",
    );

    // 6. THE GATE: export refuses while the user has not confirmed.
    const denied = await callPluginTool(host, sessionId, "ppt_script", {
      script: "svg_to_pptx",
      args: { projectPath: projectDir, format: "ppt169" },
    });
    record(
      "S10-06-export-denied",
      denied.payload?.code === "PPT_STAGE_NOT_CONFIRMED",
      "PPT_STAGE_NOT_CONFIRMED",
    );

    // 7. The user confirms on the card (panel contract → result.json).
    const { confirmStage } = await import(pathToFileURL(join(PLUGIN_DIR, "lib/ppt-state.js")).href);
    const confirmed = confirmStage(projectDir, "stage2");
    record("S10-07-user-confirmed", confirmed.state?.stages?.stage2?.status === "confirmed", "result.json written");

    // 7b. First agent read serves the full result; a later read must not.
    const firstRead = await callPluginTool(host, sessionId, "ppt_stage_status", { projectDir, stage: "stage2" });
    const firstBody = firstRead.payload?.details ?? firstRead.payload ?? {};
    record(
      "S10-07b-first-read",
      firstBody.status === "confirmed" && Boolean(firstBody.result),
      "full result served once",
    );

    // 8. Author pages (the model would do this via Write; here: direct files).
    for (const [nn, title] of [["01", "Cover"], ["02", "Status"], ["03", "Next"]]) {
      writeFileSync(
        join(projectDir, "svg_output", `${nn}_${title.toLowerCase()}.svg`),
        `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect id="page-bg" data-pptx-role="background" width="1280" height="720" fill="#FFFFFF"/>
  <text x="80" y="120" font-family="Arial" font-size="40" fill="#1F4E79">S10 replay — ${title}</text>
  <text x="80" y="180" font-family="Arial" font-size="18" fill="#1F2937">protocol-level pipeline check</text>
</svg>`,
      );
    }
    // 8b. Planner artifacts the gates and exporter require (upstream contract).
    writeFileSync(
      join(projectDir, "spec_lock.md"),
      [
        "## communication",
        "- primary_language: en-US",
        "- audience: LaboFlow engineering reviewers",
        "- objective: Prove the S10 replay path runs end to end.",
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
        "- P02: dense",
        "- P03: anchor",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(projectDir, "design_spec.md"),
      [
        "# design spec (S10 replay)",
        "",
        "## IX. Content Outline",
        "",
        "### Part 1: Opening",
        "",
        "#### Slide 01 - Cover",
        "",
        "- **Audience move**: unaware → aware",
        "- **Relationships**: none",
        "- **Composition**: title band",
        "- **Title**: S10 replay — Cover",
        "- **Core message**: pipeline works",
        "- **Content**: title only.",
        "",
      ].join("\n"),
    );

    const gates = await callPluginTool(host, sessionId, "ppt_script", {
      script: "quality_checker",
      args: { target: join(projectDir, "svg_output"), stage: "final" },
    });
    if (gates.payload?.error) console.error("gate debug:", JSON.stringify(gates).slice(0, 500));
    record("S10-08-quality-final", !gates.payload?.error, "final gate 0 errors");

    const finalize = await callPluginTool(host, sessionId, "ppt_script", {
      script: "finalize_svg",
      args: { projectDir },
    });
    record("S10-09-finalize", !finalize.payload?.error, "svg_final/");

    // 9. Export through the gate: a native editable deck lands in exports/.
    const exported = await callPluginTool(host, sessionId, "ppt_script", {
      script: "svg_to_pptx",
      args: { projectPath: projectDir, format: "ppt169" },
    });
    const exportsDir = join(projectDir, "exports");
    const deck = existsSync(exportsDir) ? readdirSync(exportsDir).find((f) => f.endsWith(".pptx")) : null;
    record("S10-10-exported", !!deck && !exported.payload?.error, deck ?? "no pptx");

    // 10. Read-once semantics: a second status read must not re-serve result.json.
    const second = await callPluginTool(host, sessionId, "ppt_stage_status", { projectDir, stage: "stage2" });
    const secondBody = second.payload?.details ?? second.payload ?? {};
    record(
      "S10-11-read-once",
      secondBody.alreadyRead === true && secondBody.result === undefined,
      "cached summary only",
    );

    // 11. UX loop: disable → enable through the real registry.
    await host.call("plugins.disable", { id: "laboflow.slides" });
    const afterDisable = (await host.call("plugins.list")).plugins.find((p) => p.id === "laboflow.slides");
    await host.call("plugins.enable", { id: "laboflow.slides" });
    const afterEnable = (await host.call("plugins.list")).plugins.find((p) => p.id === "laboflow.slides");
    record(
      "S10-12-ux-loop",
      afterDisable?.enabled === false && afterEnable?.enabled === true,
      "disable/enable roundtrip",
    );
  } finally {
    await host.dispose();
    if (!process.env.PI_DESKTOP_SLIDES_KEEP) {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\ne2e-slides-session: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED:", JSON.stringify(reason, Object.getOwnPropertyNames(reason ?? {})).slice(0, 500));
  process.exitCode = 1;
});

main();
