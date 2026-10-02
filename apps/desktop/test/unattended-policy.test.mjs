import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  interceptUnattendedAsk,
  registerUnattendedPolicy,
  clearUnattendedPolicy,
  settleUnattendedAsk,
  resetUnattendedPolicies,
  unattendedPolicyOf,
} = await import("../electron/main/assistant/unattended-policy.ts");

function recorder() {
  const calls = { resolve: [], notify: [], logs: [] };
  const deps = {
      resolve: async (requestId, decision) => {
        calls.resolve.push([requestId, decision]);
      },
      notify: (payload) => calls.notify.push(payload),
      log: (level, message) => calls.logs.push([level, message]),
    };
    deps.calls = calls;
    return { calls, deps };
}

function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const ask = {
  requestId: "req-1",
  sessionId: "sess-1",
  toolName: "Bash",
  argsPreview: "rm -rf /tmp/x",
};

test("interactive sessions pass through untouched", () => {
  resetUnattendedPolicies();
  const { deps } = recorder();
  assert.equal(interceptUnattendedAsk(ask, deps), false);
  assert.equal(deps.calls.resolve.length, 0);
});

test("strict auto-denies, notifies, and swallows the request from the UI", async () => {
  resetUnattendedPolicies();
  registerUnattendedPolicy("sess-1", "strict");
  const { deps } = recorder();
  assert.equal(interceptUnattendedAsk(ask, deps), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(deps.calls.resolve, [["req-1", "deny"]]);
  assert.ok(deps.calls.notify.some((payload) => payload.kind === "unattended.denied"));
});

test("degraded forwards to the UI but arms the deny deadline", async () => {
  resetUnattendedPolicies();
  registerUnattendedPolicy("sess-1", "degraded");
  const { deps } = recorder();
  assert.equal(interceptUnattendedAsk(ask, deps), false);
  assert.equal(deps.calls.resolve.length, 0);
  assert.ok(deps.calls.notify.some((payload) => payload.kind === "unattended.approval-requested"));
  // Resolution clears the deadline without a deny.
  settleUnattendedAsk("req-1");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(deps.calls.resolve.length, 0);
});

test("lenient behaves like an attended session", () => {
  resetUnattendedPolicies();
  registerUnattendedPolicy("sess-1", "lenient");
  const { deps } = recorder();
  assert.equal(interceptUnattendedAsk(ask, deps), false);
  assert.equal(deps.calls.resolve.length, 0);
  clearUnattendedPolicy("sess-1");
  assert.equal(unattendedPolicyOf("sess-1"), null);
});

test("launch sites declare their default policies", async () => {
  const scheduled = read("../electron/main/runtime/scheduled-runner.ts");
  assert.match(scheduled, /registerUnattendedPolicy\(launch\.sessionId, "strict"\)/);
  const channels = read("../electron/main/channels/registry.ts");
  assert.match(channels, /unattendedPolicy: "degraded"/);
  const services = read("../electron/main/laboflow/services.ts");
  assert.match(services, /unattendedPolicy: "degraded"/);
  const host = read("../electron/main/runtime/host.ts");
  assert.match(host, /interceptUnattendedAsk\(/);
});


