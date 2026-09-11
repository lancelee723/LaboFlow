import assert from "node:assert/strict";
import test from "node:test";

import { ChannelRegistry, createChannelRegistryHost } from "../electron/main/channels/registry.ts";
import { createChannelCredentialStore } from "../electron/main/channels/credential-store.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake adapter with emit hooks and a send log. */
function makeAdapter(provider = "feishu", overrides = {}) {
  const listeners = { message: [], state: [] };
  const adapter = {
    provider,
    capabilities: {
      maxTextBytes: 20480,
      fileMaxBytes: 30 * 1024 * 1024,
      streaming: false,
      card: true,
    },
    connect: async () => {},
    disconnect: async () => {},
    send: async (chatRef, payload) => {
      adapter.sent.push({ chatRef, payload });
    },
    onMessage: (cb) => listeners.message.push(cb),
    onState: (cb) => listeners.state.push(cb),
    emitMessage: (message) => {
      for (const cb of listeners.message) cb(message);
    },
    sent: [],
    listeners,
  };
  return Object.assign(adapter, overrides);
}

/** Fake driver whose runs settle only when the test resolves them. */
function makeDriver() {
  let counter = 0;
  const pending = [];
  return {
    pending,
    start: async (request) => {
      counter += 1;
      let resolve;
      const completion = new Promise((r) => {
        resolve = r;
      });
      const run = { request, resolve, sessionId: `s-${counter}` };
      pending.push(run);
      return { sessionId: run.sessionId, completion };
    },
  };
}

function baseMessage(overrides = {}) {
  return {
    channelId: "acc-1",
    provider: "feishu",
    senderRef: "ou_owner",
    chatRef: "oc_chat1",
    chatType: "p2p",
    text: "帮我查天气",
    raw: {},
    receivedAt: Date.now(),
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const adaptersById = new Map();
  const stateEvents = [];
  const inbound = [];
  const driver = makeDriver();
  const logger = { app() {} };
  const deps = {
    getDriver: () => driver,
    getLogger: () => logger,
    adapters: {
      feishu: (channelId) => {
        const adapter = makeAdapter("feishu");
        adaptersById.set(channelId, adapter);
        return adapter;
      },
      wecom: (channelId) => {
        const adapter = makeAdapter("wecom");
        adaptersById.set(channelId, adapter);
        return adapter;
      },
    },
    credentialStore: createChannelCredentialStore(),
    onInbound: (message) => inbound.push(message),
    onStateChange: (event) => stateEvents.push(event),
    ...overrides,
  };
  return { deps, driver, adaptersById, stateEvents, inbound };
}

function makeRegistry(deps = makeDeps()) {
  return { registry: new ChannelRegistry(deps.deps), ...deps };
}

async function setupConnected(registryOverrides = {}, depsOverrides = {}) {
  const h = makeRegistry(makeDeps(depsOverrides));
  await h.registry.save({
    provider: "feishu",
    allowlist: ["ou_owner"],
    credentials: { app_id: "cli_x", app_secret: "sec" },
    ...registryOverrides,
  });
  const accountId = h.registry.list()[0].id;
  await h.registry.connect(accountId);
  const adapter = [...h.adaptersById.values()][0];
  return { h, accountId, adapter };
}

test("allowlist: whitelisted sender dispatches, stranger is dropped", async () => {
  const { h, adapter } = await setupConnected();

  adapter.emitMessage(baseMessage({ senderRef: "ou_owner" }));
  await sleep(0);
  assert.equal(h.inbound.length, 1);
  assert.equal(h.driver.pending.length, 1);
  assert.equal(h.driver.pending[0].request.prompt, "帮我查天气");
  assert.equal(h.driver.pending[0].request.newSession.title, "IM·ou_owner");

  adapter.emitMessage(baseMessage({ senderRef: "ou_stranger", chatRef: "oc_chat2" }));
  await sleep(0);
  assert.equal(h.inbound.length, 1, "stranger must not reach onInbound");
  assert.equal(h.driver.pending.length, 1, "stranger must not start a run");
});

test("allowlist is fail-closed: empty allowlist drops everyone", async () => {
  const { h, adapter } = await setupConnected({ allowlist: [] });
  adapter.emitMessage(baseMessage({ senderRef: "ou_anyone" }));
  await sleep(0);
  assert.equal(h.inbound.length, 0);
  assert.equal(h.driver.pending.length, 0);
});

test("scope filter: p2p-only account drops group messages", async () => {
  const { h, adapter } = await setupConnected({ scope: "p2p" });

  adapter.emitMessage(baseMessage({ chatType: "group", chatRef: "oc_group" }));
  await sleep(0);
  assert.equal(h.driver.pending.length, 0);

  adapter.emitMessage(baseMessage({ chatType: "p2p" }));
  await sleep(0);
  assert.equal(h.driver.pending.length, 1);
});

test("serial per-chat queue: second message waits for first completion", async () => {
  const { h, adapter } = await setupConnected();

  adapter.emitMessage(baseMessage({ text: "第一条" }));
  adapter.emitMessage(baseMessage({ text: "第二条" }));
  await sleep(0);
  assert.equal(h.driver.pending.length, 1, "only the first run starts");
  assert.equal(h.driver.pending[0].request.prompt, "第一条");

  h.driver.pending[0].resolve({
    sessionId: h.driver.pending[0].sessionId,
    status: "completed",
    finalText: "今天晴",
  });
  await sleep(10);
  assert.equal(h.driver.pending.length, 2, "second run starts after the first settles");
  assert.equal(h.driver.pending[1].request.prompt, "第二条");

  // The first chat received its reply through adapter.send.
  assert.deepEqual(adapter.sent[0], {
    chatRef: "oc_chat1",
    payload: { replyText: "今天晴" },
  });
});

test("different chats dispatch concurrently", async () => {
  const { h, adapter } = await setupConnected();

  adapter.emitMessage(baseMessage({ chatRef: "oc_a" }));
  adapter.emitMessage(baseMessage({ chatRef: "oc_b" }));
  await sleep(0);
  assert.equal(h.driver.pending.length, 2);
});

test("empty final text falls back to the no-result reply", async () => {
  const { h, adapter } = await setupConnected();

  adapter.emitMessage(baseMessage());
  await sleep(0);
  h.driver.pending[0].resolve({
    sessionId: "s-1",
    status: "completed",
    finalText: "   ",
  });
  await sleep(10);
  assert.equal(adapter.sent[0].payload.replyText, "（任务结束，无文本结果）");
});

test("driver unavailable replies with a friendly notice", async () => {
  const { h, adapter } = await setupConnected({}, { getDriver: () => null });
  adapter.emitMessage(baseMessage());
  await sleep(10);
  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0].payload.replyText, "LaboFlow 后端尚未就绪，请稍后再试");
});

test("state transitions: connecting → connected on success, → error on failure", async () => {
  const deps = makeDeps();
  const failing = makeAdapter("feishu", {
    connect: async () => {
      const error = new Error("bad secret");
      error.diag = {
        kind: "credential",
        message: "app_id 或 app_secret 无效（飞书 10014）",
        rawCode: "10014",
      };
      throw error;
    },
  });
  deps.deps.adapters = {
    feishu: () => failing,
    wecom: deps.deps.adapters.wecom,
  };
  const registry = new ChannelRegistry(deps.deps);
  await registry.save({
    provider: "feishu",
    allowlist: ["ou_owner"],
    credentials: { app_id: "cli_x", app_secret: "wrong" },
  });
  await assert.rejects(() => registry.connect(registry.list()[0].id));

  const states = deps.stateEvents.map((event) => event.state);
  assert.deepEqual(states, ["connecting", "error"]);
  assert.equal(deps.stateEvents[1].diag.kind, "credential");
  assert.equal(registry.list()[0].state, "error");

  await registry.disconnect(registry.list()[0].id);
  assert.equal(registry.list()[0].state, "disconnected");
});

test("credential empty-value protection: blank save does not clear the secret", async () => {
  const h = makeRegistry();
  const saved = await h.registry.save({
    provider: "feishu",
    allowlist: ["ou_owner"],
    credentials: { app_id: "cli_x", app_secret: "real-secret" },
  });
  assert.equal(saved.hasCredentials, true);

  // Second save leaves the secret blank → unchanged, not cleared.
  const resaved = await h.registry.save({
    id: saved.id,
    provider: "feishu",
    credentials: { app_secret: "   " },
  });
  assert.equal(resaved.hasCredentials, true);

  const store = h.registry.getCredentialStore();
  assert.equal(await store.get(`channel:${saved.id}:app_secret`), "real-secret");
});

test("views never expose credentials; saved snapshots are credential-free", async () => {
  const persisted = [];
  const deps = makeDeps({
    saveAccounts: async (accounts) => {
      persisted.push(accounts);
    },
  });
  const registry = new ChannelRegistry(deps.deps);
  await registry.save({
    provider: "wecom",
    name: "企微",
    allowlist: ["userid_a"],
    credentials: { bot_id: "bot", secret: "s3cret" },
  });

  const view = registry.list()[0];
  assert.ok(!("credentials" in view));
  assert.equal(view.hasCredentials, true);
  assert.equal(view.provider, "wecom");

  assert.ok(persisted.length >= 1);
  for (const snapshot of persisted) {
    for (const account of snapshot) {
      assert.equal(account.credentials, undefined, "snapshots must strip credentials");
    }
  }
});

test("connect without any stored credential fails with a credential diag", async () => {
  const h = makeRegistry();
  await h.registry.save({ provider: "feishu", allowlist: ["ou_owner"] });
  await assert.rejects(() => h.registry.connect(h.registry.list()[0].id));
  assert.equal(h.registry.list()[0].state, "error");
  assert.equal(h.stateEvents.at(-1).diag.kind, "credential");
});

test("delete removes account, credentials, and disconnects", async () => {
  const h = makeRegistry();
  const saved = await h.registry.save({
    provider: "feishu",
    allowlist: ["ou_owner"],
    credentials: { app_id: "cli_x", app_secret: "sec" },
  });
  await h.registry.connect(saved.id);
  const store = h.registry.getCredentialStore();
  await h.registry.delete(saved.id);
  assert.equal(h.registry.list().length, 0);
  assert.equal(await store.get(`channel:${saved.id}:app_secret`), null);
});

test("createChannelRegistryHost registers all channels/* IPC handlers", async () => {
  const h = makeRegistry();
  const host = createChannelRegistryHost({
    getLogger: h.deps.getLogger,
    getDriver: h.deps.getDriver,
    adapters: h.deps.adapters,
    credentialStore: h.deps.credentialStore,
    broadcast: h.deps.onStateChange,
    onInbound: h.deps.onInbound,
  });
  const handlers = new Map();
  host.registerIpc((channel, fn) => handlers.set(channel, fn));

  const { IPC } = await import("@pi-desktop/shared");
  for (const key of [
    "channelsList",
    "channelsSave",
    "channelsDelete",
    "channelsConnect",
    "channelsDisconnect",
    "channelsTest",
  ]) {
    assert.ok(handlers.has(IPC.invoke[key]), `missing handler for ${key}`);
  }

  const saved = await handlers.get(IPC.invoke.channelsSave)({
    provider: "feishu",
    allowlist: ["ou_owner"],
    credentials: { app_id: "cli_x", app_secret: "sec" },
  });
  assert.equal(saved.provider, "feishu");
  const list = await handlers.get(IPC.invoke.channelsList)();
  assert.equal(list.length, 1);
  const conn = await handlers.get(IPC.invoke.channelsConnect)(saved.id);
  assert.equal(conn.state, "connected");
  const health = await handlers.get(IPC.invoke.channelsTest)(saved.id);
  assert.equal(health.ok, true);
  await handlers.get(IPC.invoke.channelsDisconnect)(saved.id);
  assert.equal(host.registry.list()[0].state, "disconnected");
  await handlers.get(IPC.invoke.channelsDelete)(saved.id);
  assert.equal(host.registry.list().length, 0);
});
