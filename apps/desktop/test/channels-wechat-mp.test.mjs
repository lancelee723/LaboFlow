import assert from "node:assert/strict";
import test from "node:test";

import {
  WECHAT_MP_CAPABILITIES,
  WECHAT_MP_POLL_INTERVAL_MS,
  chunkWechatMpText,
  createWechatMpAdapter,
  createWechatMpAdapterFactory,
  normalizeWechatMpPending,
  parseWechatMpCredentials,
} from "../electron/main/channels/wechat-mp.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Outbound chunking (≤2048B)
// ---------------------------------------------------------------------------

test("chunking: short text stays a single chunk; empty text yields none", () => {
  assert.deepEqual(chunkWechatMpText("你好"), ["你好"]);
  assert.deepEqual(chunkWechatMpText(""), []);
});

test("chunking: oversized text splits into ≤2048-byte chunks and round-trips", () => {
  const text = "a".repeat(6000);
  const chunks = chunkWechatMpText(text);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, "utf8") <= 2048);
  }
  assert.equal(chunks.join(""), text);
});

test("chunking: multibyte content never splits a code point", () => {
  const text = "汉".repeat(1200); // 3600B
  const chunks = chunkWechatMpText(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, "utf8") <= 2048);
    assert.ok(!chunk.includes("\uFFFD"), "no replacement characters");
  }
  assert.equal(chunks.join(""), text);
});

test("chunking: prefers paragraph boundaries; stripped separators are only redundant", () => {
  const paragraph = "a".repeat(1000);
  const text = [paragraph, paragraph, paragraph].join("\n\n");
  const chunks = chunkWechatMpText(text);
  assert.deepEqual(chunks, [`${paragraph}\n\n${paragraph}`, paragraph]);
  assert.equal(chunks.join("\n\n"), text);
});

// ---------------------------------------------------------------------------
// Inbound normalization: relay pending message → InboundMessage
// ---------------------------------------------------------------------------

test("normalization: FromUserName → senderRef/chatRef, Content → text, p2p", () => {
  const inbound = normalizeWechatMpPending(
    {
      id: "row-1",
      botId: "bot-1",
      appId: "wx123",
      fromUser: "oFAN-OPENID",
      msgType: "text",
      content: "帮我跑个测试",
      msgId: "MSG-1",
      createTime: 1348831860,
      receivedAt: 1726000000000,
    },
    "acc-wx",
  );
  assert.equal(inbound.provider, "wechat_mp");
  assert.equal(inbound.channelId, "acc-wx");
  assert.equal(inbound.senderRef, "oFAN-OPENID");
  assert.equal(inbound.chatRef, "oFAN-OPENID");
  assert.equal(inbound.chatType, "p2p");
  assert.equal(inbound.text, "帮我跑个测试");
});

test("normalization: non-text messages and empty openid are ignored", () => {
  assert.equal(
    normalizeWechatMpPending(
      { id: "r", botId: "b", appId: "wx", fromUser: "o1", msgType: "image", content: "", },
      "acc-wx",
    ),
    null,
  );
  assert.equal(
    normalizeWechatMpPending(
      { id: "r", botId: "b", appId: "wx", fromUser: "", msgType: "text", content: "hi" },
      "acc-wx",
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// Credentials: server_url (+ optional bot pin); JWT never in credentials
// ---------------------------------------------------------------------------

const ACCOUNT = {
  id: "acc-wx",
  provider: "wechat_mp",
  name: "组织公众号",
  scope: "both",
  allowlist: ["oFAN-OPENID"],
  enabled: true,
  credentials: { server_url: "https://relay.example.com/", bot_id: "bot-1" },
};

test("credentials: server_url trailing slash trimmed, bot_id optional; missing → null", () => {
  assert.deepEqual(parseWechatMpCredentials(ACCOUNT), {
    serverUrl: "https://relay.example.com",
    botId: "bot-1",
  });
  assert.deepEqual(parseWechatMpCredentials({ ...ACCOUNT, credentials: { server_url: "https://x" } }), {
    serverUrl: "https://x",
  });
  assert.equal(parseWechatMpCredentials({ ...ACCOUNT, credentials: { bot_id: "b" } }), null);
});

test("credentials: account server_url wins over the factory getter fallback", async () => {
  const clock = makeManualClock();
  const stub = makeFetchStub();
  const adapter = createWechatMpAdapter("acc-wx", {
    tokenProvider: async () => "JWT",
    schedule: clock.schedule,
    fetchImpl: stub.fetchImpl,
    serverUrl: () => "https://fallback.example.com",
  });
  await adapter.connect(ACCOUNT); // credentials.server_url = https://relay.example.com
  await clock.fire();
  assert.ok(stub.calls[0].url.startsWith("https://relay.example.com"), "account server_url wins");

  const fallbackAdapter = createWechatMpAdapter("acc-wx", {
    tokenProvider: async () => "JWT",
    schedule: clock.schedule,
    fetchImpl: stub.fetchImpl,
    serverUrl: () => "https://fallback.example.com/",
  });
  await fallbackAdapter.connect({ ...ACCOUNT, credentials: {} }); // fall back to the getter
  await clock.fire();
  const poll = stub.calls.at(-1);
  assert.ok(poll.url.startsWith("https://fallback.example.com/org/wechat-mp/pending"), "getter fallback used at connect time");
  await adapter.disconnect();
  await fallbackAdapter.disconnect();
});

// ---------------------------------------------------------------------------
// Poll loop with injectable timer (deterministic; no stray timers at exit)
// ---------------------------------------------------------------------------

function makeManualClock() {
  const clock = {
    cb: null,
    lastDelay: null,
    schedule(fn, ms) {
      clock.cb = fn;
      clock.lastDelay = ms;
      return () => {
        clock.cb = null;
      };
    },
    async fire() {
      const fn = clock.cb;
      if (!fn) return;
      clock.cb = null;
      fn();
      await sleep(0);
    },
    get pending() {
      return clock.cb !== null;
    },
  };
  return clock;
}

function makeFetchStub(initialPending = []) {
  const calls = [];
  const stub = {
    calls,
    pendingMessages: initialPending,
    pendingStatus: 200,
    sendStatus: 200,
    sendPayload: { ok: true, chunks: 1 },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.includes("/org/wechat-mp/pending")) {
        const messages = stub.pendingMessages;
        stub.pendingMessages = [];
        return {
          ok: stub.pendingStatus === 200,
          status: stub.pendingStatus,
          json: async () => ({ messages }),
        };
      }
      if (url.includes("/org/wechat-mp/send")) {
        return {
          ok: stub.sendStatus === 200,
          status: stub.sendStatus,
          json: async () => stub.sendPayload,
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
  return stub;
}

async function makeConnectedAdapter(options = {}) {
  const clock = makeManualClock();
  const stub = makeFetchStub();
  const received = [];
  const states = [];
  const adapter = createWechatMpAdapter("acc-wx", {
    tokenProvider: async () => "JWT-SESSION-1",
    pollIntervalMs: WECHAT_MP_POLL_INTERVAL_MS,
    schedule: clock.schedule,
    fetchImpl: stub.fetchImpl,
    ...options,
  });
  adapter.onMessage((m) => received.push(m));
  adapter.onState((s, diag) => states.push({ s, diag }));
  await adapter.connect(ACCOUNT);
  await clock.fire(); // first tick (scheduled with 0ms)
  return { clock, stub, received, states, adapter };
}

const PENDING_MSG = {
  id: "row-1",
  botId: "bot-1",
  appId: "wx123",
  fromUser: "oFAN-OPENID",
  msgType: "text",
  content: "帮我跑个测试",
  msgId: "MSG-1",
  receivedAt: 1726000000000,
};

test("poll loop: first tick polls immediately with the org JWT; interval rescheduled", async () => {
  const { clock, stub, received, adapter } = await makeConnectedAdapter();
  assert.equal(received.length, 0);
  const pollCall = stub.calls[0];
  assert.equal(pollCall.url, "https://relay.example.com/org/wechat-mp/pending");
  assert.equal(pollCall.init.headers.authorization, "Bearer JWT-SESSION-1");
  assert.equal(clock.lastDelay, WECHAT_MP_POLL_INTERVAL_MS, "next tick uses the 5s default");
  await adapter.disconnect();
});

test("poll loop: pending message → normalized onMessage + route remembered", async () => {
  const { clock, stub, received, adapter } = await makeConnectedAdapter();
  stub.pendingMessages = [PENDING_MSG];
  await clock.fire();
  assert.equal(received.length, 1);
  assert.equal(received[0].text, "帮我跑个测试");
  assert.equal(received[0].senderRef, "oFAN-OPENID");
  await adapter.disconnect();
});

test("poll loop: 401 → credential error state", async () => {
  const clock = makeManualClock();
  const stub = makeFetchStub();
  stub.pendingStatus = 401;
  const states = [];
  const adapter = createWechatMpAdapter("acc-wx", {
    tokenProvider: async () => "JWT",
    schedule: clock.schedule,
    fetchImpl: stub.fetchImpl,
  });
  adapter.onState((s, diag) => states.push({ s, diag }));
  await adapter.connect(ACCOUNT);
  await clock.fire();
  assert.equal(states.at(-1).s, "error");
  assert.equal(states.at(-1).diag.kind, "credential");
  await adapter.disconnect();
});

test("poll loop: 3 consecutive network failures → network diag; recovery → connected", async () => {
  const clock = makeManualClock();
  let impl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const states = [];
  const adapter = createWechatMpAdapter("acc-wx", {
    tokenProvider: async () => "JWT",
    schedule: clock.schedule,
    fetchImpl: (url, init) => impl(url, init),
  });
  adapter.onState((s, diag) => states.push({ s, diag }));
  await adapter.connect(ACCOUNT);
  await clock.fire();
  await clock.fire();
  assert.equal(states.length, 0, "first two failures stay silent (transient)");
  await clock.fire();
  assert.equal(states.at(-1).s, "error");
  assert.equal(states.at(-1).diag.kind, "network");

  // 恢复：换健康实现 → 下一次成功轮询回落 connected 态
  const stub = makeFetchStub();
  impl = stub.fetchImpl;
  await clock.fire();
  assert.equal(states.at(-1).s, "connected");
  await adapter.disconnect();
});

test("adapter outbound: send chunks ≤2048B posts with botId+toUser from inbound route", async () => {
  const { clock, stub, adapter } = await makeConnectedAdapter();
  stub.pendingMessages = [PENDING_MSG];
  await clock.fire(); // learn route {botId, appId} for oFAN-OPENID
  stub.calls.length = 0;

  const big = "汉".repeat(1200); // 3600B → 2 chunks
  await adapter.send("oFAN-OPENID", { replyText: big });
  const sendCalls = stub.calls.filter((c) => c.url.includes("/org/wechat-mp/send"));
  assert.equal(sendCalls.length, 2);
  const joined = sendCalls
    .map((c) => JSON.parse(c.init.body))
    .map((b) => b.text)
    .join("");
  assert.equal(joined, big);
  for (const c of sendCalls) {
    const body = JSON.parse(c.init.body);
    assert.equal(body.botId, "bot-1");
    assert.equal(body.appId, "wx123");
    assert.equal(body.toUser, "oFAN-OPENID");
    assert.ok(Buffer.byteLength(body.text, "utf8") <= 2048);
    assert.equal(c.init.headers.authorization, "Bearer JWT-SESSION-1");
  }
  await adapter.disconnect();
});

test("adapter outbound: statusCard → plain-text transcription (card=false on 公众号)", async () => {
  const { clock, stub, adapter } = await makeConnectedAdapter();
  stub.pendingMessages = [PENDING_MSG];
  await clock.fire();
  stub.calls.length = 0;
  await adapter.send("oFAN-OPENID", {
    replyText: "",
    statusCard: { title: "任务完成", status: "成功", detail: "耗时 3s" },
  });
  const body = JSON.parse(stub.calls[0].init.body);
  assert.equal(body.text, "【任务完成】成功\n耗时 3s");
  await adapter.disconnect();
});

test("adapter outbound: server diag (45015 window) propagates as diag error", async () => {
  const { clock, stub, adapter } = await makeConnectedAdapter();
  stub.pendingMessages = [PENDING_MSG];
  await clock.fire();
  stub.calls.length = 0;
  stub.sendPayload = {
    ok: false,
    errcode: 45015,
    errmsg: "reply out of range",
    diag: { kind: "permission", message: "客服回复窗口已关闭", rawCode: "45015" },
  };
  await assert.rejects(
    () => adapter.send("oFAN-OPENID", { replyText: "超窗" }),
    (error) => {
      assert.equal(error.diag.kind, "permission");
      assert.equal(error.diag.rawCode, "45015");
      return true;
    },
  );
  await adapter.disconnect();
});

test("adapter outbound before connect fails", async () => {
  const stub = makeFetchStub();
  const adapter = createWechatMpAdapter("acc-wx", {
    tokenProvider: async () => "JWT",
    fetchImpl: stub.fetchImpl,
  });
  await assert.rejects(() => adapter.send("oFAN-OPENID", { replyText: "hi" }));
});

test("adapter connect without server_url → credential diag error", async () => {
  const states = [];
  const adapter = createWechatMpAdapter("acc-wx", {
    tokenProvider: async () => "JWT",
    fetchImpl: makeFetchStub().fetchImpl,
  });
  adapter.onState((s, diag) => states.push({ s, diag }));
  await assert.rejects(
    () => adapter.connect({ ...ACCOUNT, credentials: {} }),
    (error) => error.diag.kind === "credential",
  );
  assert.equal(states.at(-1).s, "error");
  assert.equal(states.at(-1).diag.kind, "credential");
});

test("connection health check: healthy → null; 401 → credential diag; unreachable → network", async () => {
  const stub = makeFetchStub();
  const healthy = createWechatMpAdapter("acc-wx", {
    tokenProvider: async () => "JWT",
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(await healthy.test(ACCOUNT), null);

  stub.pendingStatus = 401;
  const unauthorized = createWechatMpAdapter("acc-wx", {
    tokenProvider: async () => "JWT",
    fetchImpl: stub.fetchImpl,
  });
  const diag = await unauthorized.test(ACCOUNT);
  assert.equal(diag.kind, "credential");

  const unreachable = createWechatMpAdapter("acc-wx", {
    tokenProvider: async () => "JWT",
    fetchImpl: async () => {
      throw new Error("no route");
    },
  });
  assert.equal((await unreachable.test(ACCOUNT)).kind, "network");
});

test("disconnect stops the timer loop (clean test exit) and clears state", async () => {
  const { clock, adapter } = await makeConnectedAdapter();
  assert.ok(clock.pending, "a tick is scheduled while connected");
  await adapter.disconnect();
  assert.ok(!clock.pending, "no timer left after disconnect");
});

test("capabilities declare wechat_mp limits (2048B text, no files/cards, 48h window)", () => {
  assert.equal(WECHAT_MP_CAPABILITIES.maxTextBytes, 2048);
  assert.equal(WECHAT_MP_CAPABILITIES.fileMaxBytes, 0);
  assert.equal(WECHAT_MP_CAPABILITIES.streaming, false);
  assert.equal(WECHAT_MP_CAPABILITIES.card, false);
  assert.equal(WECHAT_MP_CAPABILITIES.replyWindowMs, 48 * 60 * 60 * 1000);
});

test("adapter factory binds the shared tokenProvider seam per instance", () => {
  let tokenCalls = 0;
  const factory = createWechatMpAdapterFactory({ tokenProvider: async () => { tokenCalls += 1; return "JWT"; } });
  const a = factory("a");
  const b = factory("b");
  assert.notEqual(a, b);
  assert.equal(a.provider, "wechat_mp");
  assert.equal(b.provider, "wechat_mp");
});
