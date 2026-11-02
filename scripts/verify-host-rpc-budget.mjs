#!/usr/bin/env node
/**
 * Live verification for the host RPC budget fix (遗留 A, branch
 * fix/rpc-budget-dispatch): drives the patched host-core binary over stdio
 * JSON-RPC with the PPT-Master failure recipe adapted headless —
 *
 *   R1  two concurrent heavy Bash calls (the 双并发重 Python pattern)
 *   R2  a storm of lightweight probes (echo / fixed-budget methods) while
 *       the heavies run — the "even echo died at 270s" starvation mode
 *   R3  an unanswered ask-mode permission prompt — must end as the enforced
 *       structured PERMISSION_TIMEOUT denial (~120s), never as a -32030
 *       budget kill, and must not leak a pending permission
 *
 * Verdict: zero -32030 responses anywhere, light probes stay fast, R3 ends
 * as documented. Exit 0 on pass, 1 on fail. The scratch data dir is created
 * under the OS temp dir and removed on success.
 *
 * Usage: node scripts/verify-host-rpc-budget.mjs [path-to-host-binary]
 * Defaults to target/release/pi-desktop-host-core in this repo.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BINARY =
  process.argv[2] ?? join(REPO, "target/release/pi-desktop-host-core");
const PROTOCOL_VERSION = 11;
const HEAVY_MS = 90_000;
const PERMISSION_CAP_MS = 120_000;

function fail(message) {
  console.error(`verify: ${message}`);
  process.exit(1);
}

if (!BINARY || !BINARY.endsWith("pi-desktop-host-core")) {
  fail(`host binary path looks wrong: ${BINARY}`);
}

const dataDir = mkdtempSync(join(tmpdir(), "laboflow-rpc-verify-"));
// PluginManager::new refreshes the market catalog at boot; without a fresh
// cache it goes to the network with retry loops. Seed the cache so boot is
// instant and offline (no sourceUrl in the meta = bundled-fallback catalog,
// which the source check keeps unconditionally).
mkdirSync(join(dataDir, "plugins/market"), { recursive: true });
writeFileSync(
  join(dataDir, "plugins/market/catalog.json"),
  JSON.stringify({ schema_version: 1, provider_id: "official", plugins: [] }),
);
writeFileSync(
  join(dataDir, "plugins/market/cache-meta.json"),
  JSON.stringify({ fetchedAt: new Date().toISOString() }),
);
const child = spawn(BINARY, [], {
  env: { ...process.env, PI_DESKTOP_DATA_DIR: dataDir, RUST_LOG: "warn" },
  stdio: ["pipe", "pipe", "pipe"],
});
child.on("exit", (code) => fail(`host exited early (code ${code})`));

const pending = new Map(); // id -> { resolve, reject }
let nextId = 1;
const budgetKills = [];

const stdoutLines = createInterface({ input: child.stdout });
stdoutLines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // non-JSON noise
  }
  if (msg.id === undefined || msg.id === null) return; // notification
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.error?.code === -32030) budgetKills.push(msg.error);
  waiter.resolve(msg);
});

function call(method, params = {}, timeoutMs = 240_000) {
  const id = nextId++;
  const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => {
        pending.delete(id);
        rejectPromise(new Error(`${method} timed out after ${timeoutMs}ms`));
      },
      timeoutMs,
    );
    pending.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        resolvePromise(msg);
      },
      reject: (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    });
    child.stdin.write(frame);
  });
}

const resultOf = (msg, label) => {
  if (msg.error) throw new Error(`${label}: ${JSON.stringify(msg.error)}`);
  return msg.result;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── boot ────────────────────────────────────────────────────────────────
resultOf(await call("app.handshake", { protocolVersion: PROTOCOL_VERSION }), "handshake");
// The whole serialized ShellCatalog comes back — {configuredId, effective, ...}.
const catalog = resultOf(await call("commandShells.list", {}), "commandShells.list");
const shellId = catalog.effective?.id;
const dialect = catalog.effective?.dialect;
if (!shellId || !dialect) fail(`no effective command shell: ${JSON.stringify(catalog)}`);

const projectDir = join(dataDir, "workspace");
resultOf(await call("projects.create", { path: projectDir }), "projects.create");
// The shell runner spawns with the session workspace as its cwd: the project
// row alone does not create the directory.
mkdirSync(projectDir, { recursive: true });
const { session: autoSession } = resultOf(
  await call("session.create", {
    title: "rpc-budget-verify",
    mode: "agent",
    projectPath: projectDir,
  }),
  "session.create",
);
const sessionId = autoSession.id;
// session.create takes no permission mode — the draft configuration flows
// through session.configure (the same path the renderer's capsule uses).
resultOf(
  await call("session.configure", { id: sessionId, mode: "agent", permissionMode: "auto" }),
  "session.configure",
);

let toolCallSeq = 0;
const bash = (command, timeoutMs, inSessionId = sessionId) =>
  call("tools.execute", {
    sessionId: inSessionId,
    toolCallId: `verify-${++toolCallSeq}`,
    toolName: "Bash",
    mode: "agent",
    args: { command },
    timeoutMs,
    // Every Bash call must pin the shell snapshot it was built against
    // (COMMAND_SHELL_CHANGED otherwise).
    expectedCommandShellId: shellId,
    expectedCommandShellDialect: dialect,
  });

// ─── R1: start the heavy pair (long pool) ───────────────────────────────
const heavyStarted = Date.now();
const pythonHeavy = `python3 -c "import time; time.sleep(${Math.round(HEAVY_MS / 1000)})"`;
const heavy1 = bash(pythonHeavy, HEAVY_MS + 20_000);
const heavy2 = bash(pythonHeavy, HEAVY_MS + 20_000);

// Give the heavies a moment to actually enter execution.
await sleep(3_000);

// ─── R2: light storm while the heavies hold their slots ────────────────
const probeResults = [];
let firstEchoRaw = null;
for (let i = 0; i < 6; i += 1) {
  const started = Date.now();
  // 10s timeout keeps these in the SHORT pool (below the 60s long threshold).
  const echo = await bash(`echo probe-${i}`, 10_000);
  if (!firstEchoRaw) firstEchoRaw = echo.result ?? echo.error ?? null;
  const fixed = await call("commandShells.list", {});
  probeResults.push({
    echoMs: Date.now() - started,
    echoOk: !echo.error && echo.result?.ok === true && echo.result?.isError !== true,
    fixedOk: !fixed.error,
  });
  await sleep(500);
}
const heavyStillRunning = Date.now() - heavyStarted < HEAVY_MS;

// ─── R3: unanswered ask-mode permission prompt ends as structured denial ─
const { session: askSession } = resultOf(
  await call("session.create", {
    title: "rpc-budget-verify-ask",
    mode: "agent",
    projectPath: projectDir,
  }),
  "session.create(ask)",
);
const askSessionId = askSession.id;
resultOf(
  await call("session.configure", { id: askSessionId, mode: "agent", permissionMode: "ask" }),
  "session.configure(ask)",
);
const permissionStarted = Date.now();
const denied = await bash(`echo should-deny-after-cap`, 600_000, askSessionId);
const permissionMs = Date.now() - permissionStarted;
const denialResult = denied.result ?? null;
const denialErrorCode = denialResult?.errorCode ?? denied.error?.data?.errorCode ?? null;
const pendingAfter = resultOf(
  await call("permissions.pending", { sessionId: askSessionId }),
  "permissions.pending",
);

// ─── reap the heavies ────────────────────────────────────────────────────
const heavies = await Promise.all([heavy1, heavy2]);
const heavyMs = Date.now() - heavyStarted;

// ─── verdict ─────────────────────────────────────────────────────────────
child.kill();
const probesOk = probeResults.every((p) => p.echoOk && p.fixedOk && p.echoMs < 15_000);
const permissionOk =
  !denied.error &&
  denialErrorCode === "PERMISSION_TIMEOUT" &&
  permissionMs >= 110_000 &&
  permissionMs <= 150_000 &&
  (pendingAfter.requests ?? []).length === 0;
const verdict = {
  budgetKills: budgetKills.length,
  firstEchoRaw,
  probes: probeResults,
  probesOk,
  heavyPairMs: heavyMs,
  heavyPairRanConcurrentlyWithProbes: heavyStillRunning,
  permission: { errorCode: denialErrorCode, permissionMs, pendingAfter: (pendingAfter.requests ?? []).length },
  permissionOk,
  pass: budgetKills.length === 0 && probesOk && permissionOk,
};
console.log(JSON.stringify(verdict, null, 2));
if (verdict.pass) {
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.exit(1);
