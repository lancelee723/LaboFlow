import assert from "node:assert/strict";
import test from "node:test";

import {
  FEISHU_CAPABILITIES,
  FeishuWebhookTransport,
  buildReplyCardContent,
  buildStatusCardContent,
  createFeishuAdapter,
  createFeishuAdapterFactory,
  createFeishuRestClient,
  createFeishuWssPendingTransport,
  mapFeishuDiag,
  parseFeishuContentText,
  stripFeishuMentions,
  truncateUtf8Safe,
} from "../electron/main/channels/feishu.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** fetch stub: routes by substring, records parsed bodies. */
function makeFetchStub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    for (const route of routes) {
      if (url.includes(route.match)) {
        return route.response(calls.length);
      }
    }
    throw new Error(`unexpected url: ${url}`);
  };
  return { calls, fetchImpl };
}

const TOKEN_ROUTE = {
  match: "tenant_access_token/internal",
  response: () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, tenant_access_token: "tk_1", expire: 7200 }),
  }),
};

const MESSAGES_ROUTE = {
  match: "/im/v1/messages",
  response: () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, data: { message_id: "om_sent" } }),
  }),
};

function feishuEvent(overrides = {}) {
  const {
    messageId = "om_1",
    text = "帮我查天气",
    chatType = "p2p",
    chatId = "oc_chat1",
    sender = "ou_owner",
    messageType = "text",
  } = overrides;
  return {
    header: {
      event_type: "im.message.receive_v1",
      token: "vt",
      event_id: `ev_${messageId}`,
    },
    event: {
      message: {
        message_id: messageId,
        chat_id: chatId,
        chat_type: chatType,
        message_type: messageType,
        content: JSON.stringify({ text }),
      },
      sender: { sender_id: { open_id: sender } },
    },
  };
}

function makeWebhook(overrides = {}) {
  const received = [];
  const transport = new FeishuWebhookTransport({
    channelId: "acc-1",
    verificationToken: "vt",
    onEvent: (message) => received.push(message),
    ...overrides,
  });
  return { transport, received };
}

// ---------------------------------------------------------------------------
// Webhook transport: URL verification
// ---------------------------------------------------------------------------

test("webhook url verification echoes the challenge", async () => {
  const { transport, received } = makeWebhook();
  const reply = await transport.handle({
    type: "url_verification",
    challenge: "chw_abc",
    token: "vt",
  });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { challenge: "chw_abc" });
  assert.equal(received.length, 0);
});

test("webhook rejects a wrong verification token", async () => {
  const { transport } = makeWebhook();
  const reply = await transport.handle({
    type: "url_verification",
    challenge: "chw_abc",
    token: "WRONG",
  });
  assert.equal(reply.status, 403);
});

test("webhook decrypts the v2.0 AES envelope (sha256 key, CBC, PKCS7)", async () => {
  const { transport, received } = makeWebhook({ encryptKey: "my-encrypt-key" });
  const inner = feishuEvent({ messageId: "om_enc" });
  const encrypted = FeishuWebhookTransport.encrypt(JSON.stringify(inner), "my-encrypt-key");
  const reply = await transport.handle({ encrypt: encrypted });
  assert.equal(reply.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].text, "帮我查天气");
  assert.equal(received[0].provider, "feishu");
});

test("webhook encrypted url verification decrypts then echoes the challenge", async () => {
  const { transport } = makeWebhook({ encryptKey: "k" });
  const encrypted = FeishuWebhookTransport.encrypt(
    JSON.stringify({ type: "url_verification", challenge: "chw_enc", token: "vt" }),
    "k",
  );
  const reply = await transport.handle({ encrypt: encrypted });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { challenge: "chw_enc" });
});

test("webhook rejects encrypted payloads without a configured key", async () => {
  const { transport } = makeWebhook();
  const encrypted = FeishuWebhookTransport.encrypt("{}", "some-key");
  const reply = await transport.handle({ encrypt: encrypted });
  assert.equal(reply.status, 401);
});

test("webhook accepts a raw JSON string body", async () => {
  const { transport, received } = makeWebhook();
  const reply = await transport.handle(JSON.stringify(feishuEvent()));
  assert.equal(reply.status, 200);
  assert.equal(received.length, 1);
});

// ---------------------------------------------------------------------------
// Inbound normalization: content double parse, mentions, dedup
// ---------------------------------------------------------------------------

test("inbound: content is a JSON string parsed twice; sender/chat normalized", async () => {
  const { transport, received } = makeWebhook();
  await transport.handle(feishuEvent());
  assert.equal(received.length, 1);
  const message = received[0];
  assert.equal(message.channelId, "acc-1");
  assert.equal(message.text, "帮我查天气");
  assert.equal(message.senderRef, "ou_owner");
  assert.equal(message.chatRef, "oc_chat1");
  assert.equal(message.chatType, "p2p");
  assert.equal(message.provider, "feishu");
  assert.equal(typeof message.receivedAt, "number");
});

test("inbound: group @bot mention tags are stripped", async () => {
  const { transport, received } = makeWebhook();
  await transport.handle(
    feishuEvent({
      messageId: "om_grp",
      chatType: "group",
      chatId: "oc_group",
      text: '<at user_id="ou_bot">LaboFlow</at> 帮我查天气',
    }),
  );
  assert.equal(received.length, 1);
  assert.equal(received[0].chatType, "group");
  assert.equal(received[0].text, "帮我查天气");
});

test("inbound: post (rich text) content flattens to plain text", () => {
  const content = JSON.stringify({
    content: [
      [{ tag: "text", text: "第一行" }],
      [{ tag: "text", text: "第二行" }],
    ],
  });
  assert.equal(parseFeishuContentText("post", content), "第一行\n第二行");
  assert.equal(parseFeishuContentText("text", JSON.stringify({ text: "纯文本" })), "纯文本");
  assert.equal(parseFeishuContentText("text", "not-json"), "");
});

test("inbound: message_id dedup drops platform re-pushes", async () => {
  const { transport, received } = makeWebhook();
  await transport.handle(feishuEvent({ messageId: "om_dup" }));
  await transport.handle(feishuEvent({ messageId: "om_dup" }));
  assert.equal(received.length, 1, "same message_id twice → one onMessage");
  await transport.handle(feishuEvent({ messageId: "om_other" }));
  assert.equal(received.length, 2);
});

test("stripFeishuMentions removes all at-tags and collapses whitespace", () => {
  assert.equal(
    stripFeishuMentions('<at user_id="ou_a">A</at> hi <at user_id="ou_b">B</at>'),
    "hi",
  );
});

// ---------------------------------------------------------------------------
// Outbound REST: POST body shape via injected fetch stub
// ---------------------------------------------------------------------------

function makeConnectedAdapter(fetchRoutes = [], adapterOverrides = {}) {
  // Custom routes take precedence: they are matched before the defaults.
  const stub = makeFetchStub([TOKEN_ROUTE, ...fetchRoutes, MESSAGES_ROUTE]);
  const adapter = createFeishuAdapter("acc-1", {
    mode: "webhook",
    fetchImpl: stub.fetchImpl,
    ...adapterOverrides,
  });
  const account = {
    id: "acc-1",
    provider: "feishu",
    name: "feishu",
    scope: "both",
    allowlist: [],
    enabled: true,
    credentials: { app_id: "cli_a", app_secret: "sec" },
  };
  return { stub, adapter, account };
}

test("outbound text: tenant token then POST body shape (receive_id_type, msg_type, uuid)", async () => {
  const { stub, adapter, account } = makeConnectedAdapter();
  await adapter.connect(account);
  await adapter.send("oc_chat1", { replyText: "你好" });

  assert.equal(stub.calls.length, 2);
  const tokenCall = stub.calls[0];
  assert.ok(tokenCall.url.includes("/open-apis/auth/v3/tenant_access_token/internal"));
  assert.deepEqual(tokenCall.body, { app_id: "cli_a", app_secret: "sec" });

  const sendCall = stub.calls[1];
  assert.equal(
    sendCall.url,
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
  );
  assert.equal(sendCall.init.headers.Authorization, "Bearer tk_1");
  assert.equal(sendCall.body.receive_id, "oc_chat1");
  assert.equal(sendCall.body.msg_type, "text");
  assert.equal(sendCall.body.content, JSON.stringify({ text: "你好" }));
  assert.equal(typeof sendCall.body.uuid, "string");
  assert.ok(sendCall.body.uuid.length > 0, "uuid idempotency key present");
});

test("outbound statusCard: msg_type interactive with card header title", async () => {
  const { stub, adapter, account } = makeConnectedAdapter();
  await adapter.connect(account);
  await adapter.send("oc_chat1", {
    replyText: "",
    statusCard: { title: "任务完成", status: "成功", detail: "耗时 3s" },
  });
  const sendCall = stub.calls[1];
  assert.equal(sendCall.body.msg_type, "interactive");
  const card = JSON.parse(sendCall.body.content);
  assert.equal(card.header.title.content, "任务完成");
  assert.ok(JSON.stringify(card).includes("成功"));
});

test("buildStatusCardContent includes status and optional detail", () => {
  const card = buildStatusCardContent({ title: "T", status: "运行中" });
  assert.equal(card.elements[0].text.content, "**状态**：运行中");
});

test("error mapping: 10014/99991663→credential, 99991672→permission, publish message, network", async () => {
  assert.equal(mapFeishuDiag(10014).kind, "credential");
  assert.equal(mapFeishuDiag("99991663").kind, "credential");
  assert.equal(mapFeishuDiag(99991672).kind, "permission");
  assert.equal(mapFeishuDiag(99999999, "app is not published").kind, "publish");
  assert.equal(mapFeishuDiag(99999999, "no permission for this scope").kind, "permission");
  assert.equal(mapFeishuDiag(99999999, "weird").kind, "unknown");

  // Network failure → network diag on send.
  const stub = makeFetchStub([]);
  const adapter = createFeishuAdapter("acc-1", {
    mode: "webhook",
    fetchImpl: stub.fetchImpl,
  });
  await adapter.connect({
    id: "acc-1",
    provider: "feishu",
    scope: "both",
    allowlist: [],
    enabled: true,
    credentials: { app_id: "cli_a", app_secret: "sec" },
  });
  await assert.rejects(adapter.send("oc_chat1", { replyText: "hi" }), (error) => {
    assert.equal(error.diag.kind, "network");
    return true;
  });

  // Permission error code on send → permission diag.
  const permStub = makeFetchStub([
    TOKEN_ROUTE,
    {
      match: "/im/v1/messages",
      response: () => ({
        ok: false,
        status: 400,
        json: async () => ({ code: 99991672, msg: "app has no permission" }),
      }),
    },
  ]);
  const permAdapter = createFeishuAdapter("acc-1", {
    mode: "webhook",
    fetchImpl: permStub.fetchImpl,
  });
  await permAdapter.connect({
    id: "acc-1",
    provider: "feishu",
    scope: "both",
    allowlist: [],
    enabled: true,
    credentials: { app_id: "cli_a", app_secret: "sec" },
  });
  await assert.rejects(permAdapter.send("oc_chat1", { replyText: "hi" }), (error) => {
    assert.equal(error.diag.kind, "permission");
    assert.equal(String(error.diag.rawCode), "99991672");
    return true;
  });
});

test("test(): token grant success returns null, credential failure returns diag", async () => {
  const okStub = makeFetchStub([TOKEN_ROUTE]);
  const okClient = createFeishuRestClient({
    appId: "cli_a",
    appSecret: "sec",
    fetchImpl: okStub.fetchImpl,
  });
  assert.equal(await okClient.testConnection(), null);

  const badStub = makeFetchStub([
    {
      match: "tenant_access_token/internal",
      response: () => ({
        ok: false,
        status: 200,
        json: async () => ({ code: 10014, msg: "app_id not exist" }),
      }),
    },
  ]);
  const badClient = createFeishuRestClient({
    appId: "cli_bad",
    appSecret: "sec",
    fetchImpl: badStub.fetchImpl,
  });
  const diag = await badClient.testConnection();
  assert.equal(diag.kind, "credential");
  assert.equal(String(diag.rawCode), "10014");
});

test("adapter test() with hydrated credentials pings the token endpoint", async () => {
  const { stub, adapter, account } = makeConnectedAdapter();
  const diag = await adapter.test(account);
  assert.equal(diag, null);
  assert.equal(stub.calls.length, 1);
  const missing = await adapter.test({ ...account, credentials: {} });
  assert.equal(missing.kind, "credential");
});

// ---------------------------------------------------------------------------
// WSS transport seam (official SDK pending) + capabilities
// ---------------------------------------------------------------------------

test("wss transport seam fails with the documented pending diagnostic", async () => {
  const transport = createFeishuWssPendingTransport();
  await assert.rejects(() => transport.connect(), (error) => {
    assert.equal(error.diag.kind, "unknown");
    assert.equal(error.diag.message, "wss endpoint requires official SDK transport (pending)");
    return true;
  });
});

test("default (wss) adapter connect surfaces the pending diag as an error state", async () => {
  const states = [];
  const adapter = createFeishuAdapter("acc-1");
  adapter.onState((state, diag) => states.push({ state, diag }));
  await assert.rejects(() =>
    adapter.connect({
      id: "acc-1",
      provider: "feishu",
      scope: "both",
      allowlist: [],
      enabled: true,
      credentials: { app_id: "cli_a", app_secret: "sec" },
    }),
  );
  await sleep(0);
  assert.equal(states.at(-1).state, "error");
  assert.equal(states.at(-1).diag.message.includes("pending"), true);
});

test("connect without credentials fails fast with a credential diag", async () => {
  const adapter = createFeishuAdapter("acc-1", { mode: "webhook" });
  await assert.rejects(
    () =>
      adapter.connect({
        id: "acc-1",
        provider: "feishu",
        scope: "both",
        allowlist: [],
        enabled: true,
      }),
    (error) => {
      assert.equal(error.diag.kind, "credential");
      return true;
    },
  );
});

test("webhook-mode adapter: connect → connected, handleWebhook dispatches", async () => {
  const states = [];
  const received = [];
  const adapter = createFeishuAdapter("acc-1", { mode: "webhook" });
  adapter.onMessage((m) => received.push(m));
  adapter.onState((state) => states.push(state));
  await adapter.connect({
    id: "acc-1",
    provider: "feishu",
    scope: "both",
    allowlist: [],
    enabled: true,
    credentials: { app_id: "cli_a", app_secret: "sec", verification_token: "vt" },
  });
  assert.equal(states.at(-1), "connected");

  const reply = await adapter.handleWebhook(feishuEvent({ messageId: "om_wh" }));
  assert.equal(reply.status, 200);
  assert.equal(received.length, 1);
});

test("capabilities declare feishu limits", () => {
  assert.equal(FEISHU_CAPABILITIES.maxTextBytes, 150 * 1024);
  assert.equal(FEISHU_CAPABILITIES.fileMaxBytes, 30 * 1024 * 1024);
  assert.equal(FEISHU_CAPABILITIES.card, true);
  assert.equal(FEISHU_CAPABILITIES.streaming, true); // FR-IM-07 card patches
});

test("truncateUtf8Safe never splits a code point", () => {
  const text = "汉".repeat(100);
  const cut = truncateUtf8Safe(text, 149); // 149 bytes → 49 chars + ellipsis
  assert.ok(!cut.includes("\uFFFD"));
  assert.equal(Buffer.byteLength(cut, "utf8") <= 150, true);
  assert.equal(truncateUtf8Safe("short", 100), "short");
});

test("adapter factory creates independent adapters", () => {
  const factory = createFeishuAdapterFactory({ mode: "webhook" });
  const a = factory("a");
  const b = factory("b");
  assert.notEqual(a, b);
  assert.equal(a.provider, "feishu");
});

// ---------------------------------------------------------------------------
// FR-IM-07: rich reply cards + streaming card patches
// ---------------------------------------------------------------------------

test("reply card: short body stays flat, long body folds into a collapsible panel", () => {
  const short = buildReplyCardContent({
    title: "帮我查天气",
    status: "完成",
    elapsedMs: 42_000,
    totalTokens: 12_345,
    text: "今天是晴天。",
  });
  assert.equal(short.schema, undefined, "short card keeps the v1 shape");
  assert.match(short.elements[0].text.content, /\*\*状态\*\*：完成/);
  assert.match(short.elements[0].text.content, /41\.0s|42\.0s|40\.0s/);
  assert.match(short.elements[0].text.content, /12,345/);
  assert.equal(short.elements[2].text.content, "今天是晴天。");

  const long = buildReplyCardContent({
    title: "调研报告",
    status: "完成",
    text: "很长的结论。".repeat(400),
  });
  assert.equal(long.schema, "2.0");
  const panel = long.body.elements.find((el) => el.tag === "collapsible_panel");
  assert.ok(panel, "long body folds");
  assert.equal(panel.expanded, false, "folded by default = 展开全文");
  assert.match(panel.elements[0].text.content, /很长的结论/);
});

test("reply card: failure renders a red header and meta-only card when no text", () => {
  const failed = buildReplyCardContent({ title: "T", status: "失败" });
  assert.equal(failed.header.template, "red");
  assert.equal(failed.elements.length, 1);
  assert.match(failed.elements[0].text.content, /\*\*状态\*\*：失败/);
});

test("streaming: sendCard creates the bubble, patchCard PATCHes the same message", async () => {
  const stub = makeFetchStub([
    TOKEN_ROUTE,
    {
      match: "/im/v1/messages?receive_id_type",
      response: () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { message_id: "om_1" } }),
      }),
    },
    {
      match: "/im/v1/messages/om_1",
      response: () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) }),
    },
  ]);
  const adapter = createFeishuAdapter("acc-stream", {
    mode: "webhook",
    fetchImpl: stub.fetchImpl,
  });
  await adapter.connect({
    id: "acc-stream",
    provider: "feishu",
    scope: "both",
    allowlist: [],
    enabled: true,
    credentials: { app_id: "cli_x", app_secret: "sec" },
  });
  const messageId = await adapter.sendCard("oc_chat", {
    replyText: "任务",
    replyCard: { title: "任务", status: "运行中" },
  });
  assert.equal(messageId, "om_1");
  const createCall = stub.calls.find((c) => c.url.includes("receive_id_type"));
  assert.equal(createCall.body.msg_type, "interactive");
  const created = JSON.parse(createCall.body.content);
  assert.match(created.elements[0].text.content, /运行中/);

  await adapter.patchCard("om_1", {
    replyText: "完成",
    replyCard: { title: "任务", status: "完成", elapsedMs: 1_500, text: "结果在此" },
  });
  const patchCall = stub.calls.find((c) => c.init.method === "PATCH");
  assert.ok(patchCall, "card patched in place");
  assert.ok(patchCall.url.includes("/im/v1/messages/om_1"));
  const patched = JSON.parse(patchCall.body.content);
  assert.match(patched.elements[0].text.content, /完成/);
  assert.match(patched.elements[0].text.content, /1\.5s/);
  await adapter.disconnect();
});

test("capabilities flip streaming on for the card patch path", () => {
  assert.equal(FEISHU_CAPABILITIES.streaming, true);
  assert.equal(FEISHU_CAPABILITIES.card, true);
});
