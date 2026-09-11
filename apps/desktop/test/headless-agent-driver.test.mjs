import assert from "node:assert/strict";
import test from "node:test";

import {
  beginDurableTurnAndPrompt,
  createHeadlessAgentDriver,
} from "../electron/main/headless-agent-driver.ts";

/** Scripted host: records calls, answers from a method -> response map. */
function scriptHost(routes) {
  const calls = [];
  return {
    calls,
    host: {
      call: async (method, params) => {
        calls.push({ method, params });
        const route = routes[method];
        if (!route) throw new Error(`unexpected host call: ${method}`);
        return route(params);
      },
    },
  };
}

function scriptSidecar(routes) {
  const calls = [];
  return {
    calls,
    sidecar: {
      call: async (method, params) => {
        calls.push({ method, params });
        const route = routes[method];
        if (!route) throw new Error(`unexpected sidecar call: ${method}`);
        return route(params);
      },
      setProjectInstructionRoot() {},
      clearProjectInstructionRoot() {},
      clearVendorAuthBindings() {},
    },
  };
}

const LAUNCH = {
  providerId: "prov-1",
  modelId: "model-1",
  projectPath: "/tmp/project",
  sidecarParams: { sessionId: "s-1", mode: "agent", provider: { id: "prov-1" } },
};

function makeDeps(overrides = {}) {
  const activeTurns = new Map();
  const activeTurnUsages = new Map();
  const settlements = new Map();
  const settlementWaiters = new Map();
  const sent = [];
  const finished = [];
  const deps = {
    getHost: () => null,
    getSidecar: () => null,
    resolveLaunch: async () => LAUNCH,
    finishTurn: async (sessionId, status, errorCode) => {
      finished.push({ sessionId, status, errorCode });
      const turnId = activeTurns.get(sessionId) ?? "";
      const key = `${sessionId}:${turnId}`;
      settlements.set(key, { status, errorCode });
      activeTurns.delete(sessionId);
      const waiters = settlementWaiters.get(key);
      settlementWaiters.delete(key);
      for (const resolve of waiters ?? []) resolve();
      return undefined;
    },
    waitForTurnSettlement: (sessionId, turnId) => {
      if (activeTurns.get(sessionId) !== turnId) return Promise.resolve();
      const key = `${sessionId}:${turnId}`;
      return new Promise((resolve) => {
        const waiters = settlementWaiters.get(key) ?? new Set();
        waiters.add(resolve);
        settlementWaiters.set(key, waiters);
      });
    },
    consumeTurnSettlement: (sessionId, turnId) => {
      const key = `${sessionId}:${turnId}`;
      const value = settlements.get(key);
      settlements.delete(key);
      return value;
    },
    activeTurns,
    activeTurnUsages,
    sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
    agentMessageEvent: "agent-message-event",
    logger: { app() {} },
    ...overrides,
  };
  return { deps, activeTurns, settlements, settlementWaiters, sent, finished };
}

/** Settle a turn the way the real sidecar event loop does (agent_end). */
function settleFromEventStream({ settlements, activeTurns, settlementWaiters }, sessionId, turnId, status = "completed") {
  settlements.set(`${sessionId}:${turnId}`, { status });
  activeTurns.delete(sessionId);
  for (const resolve of settlementWaiters.get(`${sessionId}:${turnId}`) ?? []) {
    resolve();
  }
}

test("driver rejects an empty prompt", async () => {
  const driver = createHeadlessAgentDriver(makeDeps().deps);
  await assert.rejects(
    () => driver.start({ prompt: "   " }),
    /prompt required/,
  );
});

test("driver rejects contract modes (interactive-only semantics)", async () => {
  const driver = createHeadlessAgentDriver(makeDeps().deps);
  await assert.rejects(
    () => driver.start({ prompt: "x", mode: "plan" }),
    (error) => error.errorCode === "PLAN_REQUIRES_INTERACTIVE_SESSION",
  );
});

test("headless run on an existing session: durable turn, prompt, settlement", async () => {
  const messages = [];
  const { host, calls } = scriptHost({
    "session.get": () => ({
      session: { id: "s-1", mode: "agent", providerId: "prov-1", modelId: "model-1", messages },
    }),
    "settings.get": () => ({ defaultMode: "agent" }),
    "session.beginTurn": () => ({ turnId: "t-1" }),
    "session.appendMessage": ({ message }) => {
      messages.push(message);
      return {};
    },
  });
  const { sidecar, calls: sidecarCalls } = scriptSidecar({
    "agent.prompt": () => ({ accepted: true, turnId: "t-1" }),
  });
  const harness = makeDeps({
    getHost: () => host,
    getSidecar: () => sidecar,
    // The real resolveLaunch copies overrides (incl. personaPrompt) into
    // sidecarParams; the stub mirrors that contract.
    resolveLaunch: async (sessionId, session, settings, overrides = {}) => ({
      ...LAUNCH,
      sidecarParams: { ...LAUNCH.sidecarParams, personaPrompt: overrides.personaPrompt },
    }),
  });

  const driver = createHeadlessAgentDriver(harness.deps);
  const handle = await driver.start({
    sessionId: "s-1",
    prompt: "整理访谈纪要",
    personaPrompt: "你是数据分析专家",
  });

  assert.equal(handle.sessionId, "s-1");
  assert.equal(handle.turnId, "t-1");
  assert.equal(harness.activeTurns.get("s-1"), "t-1");

  // Durable turn order: beginTurn before appendMessage before sidecar prompt.
  assert.deepEqual(calls.map((call) => call.method), [
    "session.get",
    "settings.get",
    "session.beginTurn",
    "session.appendMessage",
  ]);
  const promptCall = sidecarCalls.find((call) => call.method === "agent.prompt");
  assert.ok(promptCall);
  assert.equal(promptCall.params.turnId, "t-1");
  assert.equal(promptCall.params.content, "整理访谈纪要");
  assert.match(promptCall.params.userMessageId, /^headless-/);
  assert.equal(promptCall.params.personaPrompt, "你是数据分析专家");
  assert.equal(promptCall.params.mode, "agent");

  // User message echoed to the renderer for live transcript updates.
  const echo = harness.sent.filter((entry) => entry.channel === "agent-message-event");
  assert.deepEqual(
    echo.map((entry) => entry.payload.event.type),
    ["message_start", "message_end"],
  );

  settleFromEventStream(harness, "s-1", "t-1");
  const result = await handle.completion;
  assert.equal(result.status, "completed");
  assert.equal(result.sessionId, "s-1");
  assert.equal(result.turnId, "t-1");
});

test("headless run creates a session when none is given", async () => {
  const { host } = scriptHost({
    "session.create": (params) => {
      assert.equal(params.mode, "agent");
      assert.equal(params.title, "晨报");
      assert.equal(params.projectPath, "/tmp/project");
      return { session: { id: "s-new", mode: "agent", messages: [] } };
    },
    "settings.get": () => ({}),
    "session.beginTurn": () => ({ turnId: "t-9" }),
    "session.appendMessage": () => ({}),
    "session.get": () => ({
      session: { id: "s-new", messages: [{ role: "assistant", content: "done" }] },
    }),
  });
  const { sidecar } = scriptSidecar({
    "agent.prompt": () => ({ accepted: true, turnId: "t-9" }),
  });
  const harness = makeDeps({
    getHost: () => host,
    getSidecar: () => sidecar,
  });

  const driver = createHeadlessAgentDriver(harness.deps);
  const handle = await driver.start({
    newSession: { title: "晨报", projectPath: "/tmp/project" },
    prompt: "生成晨报",
  });
  assert.equal(handle.sessionId, "s-new");

  settleFromEventStream(harness, "s-new", "t-9");
  const result = await handle.completion;
  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "done");
});

test("sidecar prompt failure closes the durable turn with error", async () => {
  const { host } = scriptHost({
    "session.get": () => ({ session: { id: "s-1", messages: [] } }),
    "settings.get": () => ({}),
    "session.beginTurn": () => ({ turnId: "t-2" }),
    "session.appendMessage": () => {},
  });
  const { sidecar } = scriptSidecar({
    "agent.prompt": () => {
      throw Object.assign(new Error("provider down"), {
        errorCode: "PROVIDER_FAILED",
      });
    },
  });
  const { deps, finished } = makeDeps({
    getHost: () => host,
    getSidecar: () => sidecar,
  });

  const driver = createHeadlessAgentDriver(deps);
  await assert.rejects(
    () => driver.start({ sessionId: "s-1", prompt: "x" }),
    /provider down/,
  );
  assert.deepEqual(finished, [
    { sessionId: "s-1", status: "error", errorCode: "PROVIDER_FAILED" },
  ]);
});

test("appendMessage failure closes the durable turn before rethrow", async () => {
  const { host } = scriptHost({
    "session.get": () => ({ session: { id: "s-1", messages: [] } }),
    "settings.get": () => ({}),
    "session.beginTurn": () => ({ turnId: "t-3" }),
    "session.appendMessage": () => {
      throw new Error("disk full");
    },
  });
  const { sidecar } = scriptSidecar({});
  const { deps, finished } = makeDeps({
    getHost: () => host,
    getSidecar: () => sidecar,
  });

  const driver = createHeadlessAgentDriver(deps);
  await assert.rejects(() => driver.start({ sessionId: "s-1", prompt: "x" }), /disk full/);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].sessionId, "s-1");
  assert.equal(finished[0].status, "error");
});

test("a busy session refuses a second headless run", async () => {
  const { host } = scriptHost({
    "session.get": () => ({ session: { id: "s-busy", messages: [] } }),
  });
  const harness = makeDeps({
    getHost: () => host,
    getSidecar: () => scriptSidecar({}).sidecar,
  });
  harness.activeTurns.set("s-busy", "t-running");

  const driver = createHeadlessAgentDriver(harness.deps);
  await assert.rejects(
    () => driver.start({ sessionId: "s-busy", prompt: "x" }),
    (error) => error.errorCode === "AGENT_BUSY",
  );
});

test("a missing session surfaces NOT_FOUND", async () => {
  const { host } = scriptHost({
    "session.get": () => ({ session: null }),
  });
  const { deps } = makeDeps({
    getHost: () => host,
    getSidecar: () => scriptSidecar({}).sidecar,
  });

  const driver = createHeadlessAgentDriver(deps);
  await assert.rejects(
    () => driver.start({ sessionId: "s-missing", prompt: "x" }),
    (error) => error.errorCode === "NOT_FOUND",
  );
});

test("timeout aborts the run and force-closes the durable turn", async () => {
  const { host } = scriptHost({
    "session.get": () => ({ session: { id: "s-1", messages: [] } }),
    "settings.get": () => ({}),
    "session.beginTurn": () => ({ turnId: "t-slow" }),
    "session.appendMessage": () => ({}),
  });
  const { sidecar, calls: sidecarCalls } = scriptSidecar({
    "agent.prompt": () => ({ accepted: true, turnId: "t-slow" }),
    "agent.abort": () => ({}),
  });
  const { deps, finished, activeTurns } = makeDeps({
    getHost: () => host,
    getSidecar: () => sidecar,
    abortGraceMs: 20,
  });

  const driver = createHeadlessAgentDriver(deps);
  const handle = await driver.start({
    sessionId: "s-1",
    prompt: "x",
    timeoutMs: 30,
  });

  // Never settles on its own; the timeout fires, the driver aborts through
  // the sidecar and force-closes the durable turn after the grace window.
  const result = await handle.completion;
  assert.equal(result.status, "aborted");
  assert.equal(result.errorCode, "HEADLESS_TIMEOUT");
  assert.ok(sidecarCalls.some((call) => call.method === "agent.abort"));
  assert.equal(activeTurns.has("s-1"), false);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, "aborted");
});

test("beginDurableTurnAndPrompt is shared with the interactive path", async () => {
  const { host, calls } = scriptHost({
    "session.beginTurn": () => ({ turnId: "t-i" }),
    "session.appendMessage": () => ({}),
  });
  const { sidecar, calls: sidecarCalls } = scriptSidecar({
    "agent.prompt": () => ({ accepted: true, turnId: "t-i" }),
  });
  const { deps, sent } = makeDeps({
    getHost: () => host,
    getSidecar: () => sidecar,
  });

  const userMessage = { id: "u-1", role: "user", content: "hello" };
  const result = await beginDurableTurnAndPrompt(deps, {
    sessionId: "s-i",
    launch: LAUNCH,
    modelContent: "hello",
    userMessage,
    echoToRenderer: true,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.turnId, "t-i");
  assert.equal(result.userMessageId, "u-1");
  assert.deepEqual(calls.map((call) => call.method), [
    "session.beginTurn",
    "session.appendMessage",
  ]);
  assert.equal(
    sidecarCalls.find((call) => call.method === "agent.prompt").params.turnId,
    "t-i",
  );
  assert.equal(sent.length, 2);
});
