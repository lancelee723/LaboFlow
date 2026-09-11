import assert from "node:assert/strict";
import test from "node:test";

import {
  WECOM_CAPABILITIES,
  WECOM_PING_INTERVAL_MS,
  WECOM_WSS_URL,
  WecomWsTransport,
  buildWecomAuthFrame,
  buildWecomMarkdownFrame,
  buildWecomPingFrame,
  buildWecomTemplateCardFrame,
  chunkWecomMarkdown,
  createWecomAdapter,
  createWecomAdapterFactory,
  createWecomPingLoop,
  normalizeWecomFrame,
  stripWecomGroupMention,
} from "../electron/main/channels/wecom.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Protocol frames: auth shape + ping
// ---------------------------------------------------------------------------

test("auth frame shape: {type:'auth', botId, secret} as the first frame", () => {
  const frame = JSON.parse(buildWecomAuthFrame("bot_123", "sec_abc"));
  assert.deepEqual(frame, { type: "auth", botId: "bot_123", secret: "sec_abc" });
  assert.equal(JSON.parse(buildWecomPingFrame()).type, "ping");
});

test("auth frame is sent on open and resolved on the first server frame", async () => {
  const sockets = [];
  const transport = new WecomWsTransport({
    botId: "bot_123",
    secret: "sec_abc",
    pingIntervalMs: 60_000,
    socketFactory: (url) => {
      const listeners = {};
      const socket = {
        sent: [],
        listeners,
        send: (data) => socket.sent.push(data),
        close: () => {
          for (const cb of listeners.close ?? []) cb({});
        },
        addEventListener: (type, cb) => {
          (listeners[type] ??= []).push(cb);
        },
        emit: (type, event = {}) => {
          for (const cb of listeners[type] ?? []) cb(event);
        },
      };
      sockets.push(socket);
      return socket;
    },
  });
  const pending = transport.connect();
  await sleep(0);
  assert.equal(sockets.length, 1);
  sockets[0].emit("open");
  await sleep(0);
  assert.equal(JSON.parse(sockets[0].sent[0]).type, "auth");
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), {
    type: "auth",
    botId: "bot_123",
    secret: "sec_abc",
  });
  sockets[0].emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  await pending;
  await transport.disconnect(); // stop the 60s ping timer
});

test("ping scheduling: ~30s cadence by default, injectable interval, stop() halts", async () => {
  const sent = [];
  const loop = createWecomPingLoop((frame) => sent.push(JSON.parse(frame)), 5);
  await sleep(35);
  const countAfterRun = sent.length;
  assert.ok(countAfterRun >= 2, `expected repeated pings, got ${countAfterRun}`);
  for (const frame of sent) assert.deepEqual(frame, { type: "ping" });
  loop.stop();
  await sleep(20);
  assert.equal(sent.length, countAfterRun, "stop() must halt the loop");
});

test("default ping interval is the documented ~30s", () => {
  assert.equal(WECOM_PING_INTERVAL_MS, 30_000);
});

// ---------------------------------------------------------------------------
// Markdown chunking (≤20480B)
// ---------------------------------------------------------------------------

test("markdown chunking: short content stays a single chunk", () => {
  assert.deepEqual(chunkWecomMarkdown("你好"), ["你好"]);
  assert.deepEqual(chunkWecomMarkdown(""), []);
});

test("markdown chunking: oversized content splits into ≤20480-byte chunks", () => {
  const text = "a".repeat(60000);
  const chunks = chunkWecomMarkdown(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, "utf8") <= 20480);
  }
  assert.equal(chunks.join(""), text, "no-newline content must round-trip");
});

test("markdown chunking: multibyte content never splits a code point", () => {
  const text = "汉".repeat(20000); // 60000 bytes
  const chunks = chunkWecomMarkdown(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, "utf8") <= 20480);
    assert.ok(!chunk.includes("\uFFFD"), "no replacement characters");
  }
  assert.equal(chunks.join(""), text);
});

test("markdown chunking: prefers paragraph boundaries", () => {
  const paragraph = "a".repeat(5000);
  const text = Array.from({ length: 10 }, () => paragraph).join("\n\n");
  const chunks = chunkWecomMarkdown(text);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, "utf8") <= 20480);
    // Cuts land after a paragraph break, so no chunk ends mid-paragraph.
    assert.ok(!chunk.endsWith("a".repeat(5000).slice(0, 10) + "\n" + paragraph.slice(0, 10)));
  }
  for (const chunk of chunks) {
    assert.ok(chunk.includes(paragraph.slice(0, 20)));
  }
});

// ---------------------------------------------------------------------------
// Inbound normalization: single chat + group @bot
// ---------------------------------------------------------------------------

test("inbound: single-chat text message → p2p, fields normalized", () => {
  const frame = {
    type: "callback",
    payload: {
      msgid: "m1",
      chatid: "wrjcA",
      chattype: "single",
      from: { userid: "zhangsan" },
      msgtype: "text",
      text: { content: "帮我跑个测试" },
    },
  };
  const parsed = normalizeWecomFrame(frame, "acc-1");
  assert.equal(parsed.chatType, "p2p");
  assert.equal(parsed.chatRef, "wrjcA");
  assert.equal(parsed.senderRef, "zhangsan");
  assert.equal(parsed.text, "帮我跑个测试");
});

test("inbound: group @bot mention is stripped from the text", () => {
  const frame = {
    payload: {
      msgid: "m2",
      chatid: "wr_group",
      chattype: "group",
      from: { userid: "lisi" },
      msgtype: "text",
      text: { content: "@LaboBot 部署到测试环境" },
    },
  };
  const parsed = normalizeWecomFrame(frame, "acc-1");
  assert.equal(parsed.chatType, "group");
  const stripped = stripWecomGroupMention(parsed.text);
  assert.equal(stripped, "部署到测试环境");
});

test("inbound: mixed message text parts are joined; voice arrives as text", () => {
  const frame = {
    payload: {
      msgid: "m3",
      chatid: "wrjcB",
      chattype: "single",
      from: { userid: "wangwu" },
      msgtype: "mixed",
      mixed: {
        msg_item: [
          { msgtype: "text", text: { content: "语音说：" } },
          { msgtype: "text", text: { content: "把报告发我" } },
        ],
      },
    },
  };
  const parsed = normalizeWecomFrame(frame, "acc-1");
  assert.equal(parsed.text, "语音说： 把报告发我");
});

test("inbound: frames without a chat id are ignored", () => {
  assert.equal(normalizeWecomFrame({ payload: { msgtype: "text" } }, "acc-1"), null);
});

// ---------------------------------------------------------------------------
// Adapter: connect (auth + ping lifecycle), inbound dispatch, outbound frames
// ---------------------------------------------------------------------------

function makeSocketRecorder() {
  const sockets = [];
  return {
    sockets,
    factory: (url) => {
      const listeners = {};
      const socket = {
        url,
        sent: [],
        listeners,
        send: (data) => socket.sent.push(data),
        close: () => {
          for (const cb of listeners.close ?? []) cb({});
        },
        addEventListener: (type, cb) => {
          (listeners[type] ??= []).push(cb);
        },
        emit: (type, event = {}) => {
          for (const cb of listeners[type] ?? []) cb(event);
        },
      };
      sockets.push(socket);
      return socket;
    },
  };
}

const ACCOUNT = {
  id: "acc-wx",
  provider: "wecom",
  name: "企微",
  scope: "both",
  allowlist: [],
  enabled: true,
  credentials: { bot_id: "bot_123", secret: "sec_abc" },
};

async function makeConnectedAdapter(options = {}) {
  const recorder = makeSocketRecorder();
  const received = [];
  const states = [];
  const adapter = createWecomAdapter("acc-wx", {
    pingIntervalMs: 5,
    socketFactory: recorder.factory,
    ...options,
  });
  adapter.onMessage((m) => received.push(m));
  adapter.onState((s) => states.push(s));
  const pending = adapter.connect(ACCOUNT);
  // Drive the fake socket handshake: open → auth frame → first server frame.
  await sleep(0);
  recorder.sockets[0].emit("open");
  await sleep(0);
  recorder.sockets[0].emit("message", { data: JSON.stringify({ type: "auth_ok" }) });
  await pending;
  return { recorder, received, states, adapter };
}

test("adapter connect: opens WSS, sends auth frame, starts pinging", async () => {
  const { recorder, states, adapter } = await makeConnectedAdapter();
  assert.equal(states.at(-1), "connected");
  assert.equal(recorder.sockets[0].url, WECOM_WSS_URL);
  assert.deepEqual(JSON.parse(recorder.sockets[0].sent[0]), {
    type: "auth",
    botId: "bot_123",
    secret: "sec_abc",
  });
  await sleep(25);
  const pingCount = recorder.sockets[0].sent.filter((f) => JSON.parse(f).type === "ping").length;
  assert.ok(pingCount >= 1, "ping loop should fire with the short test interval");
  await adapter.disconnect();
});

test("adapter connect without credentials → credential diag error state", async () => {
  const recorder = makeSocketRecorder();
  const states = [];
  const adapter = createWecomAdapter("acc-wx", { socketFactory: recorder.factory });
  adapter.onState((s, diag) => states.push({ s, diag }));
  await assert.rejects(
    () => adapter.connect({ ...ACCOUNT, credentials: {} }),
    (error) => {
      assert.equal(error.diag.kind, "credential");
      return true;
    },
  );
  assert.equal(states.at(-1).s, "error");
  assert.equal(states.at(-1).diag.kind, "credential");
});

test("adapter connect socket error → network diag", async () => {
  const recorder = makeSocketRecorder();
  const adapter = createWecomAdapter("acc-wx", { socketFactory: recorder.factory });
  const pending = adapter.connect(ACCOUNT);
  recorder.sockets[0].emit("error", {});
  await assert.rejects(() => pending, (error) => {
    assert.equal(error.diag.kind, "network");
    return true;
  });
});

test("adapter inbound: group message text stripped, single chat passthrough", async () => {
  const { recorder, received, adapter } = await makeConnectedAdapter();
  recorder.sockets[0].emit("message", {
    data: JSON.stringify({
      payload: {
        msgid: "m_g",
        chatid: "wr_group",
        chattype: "group",
        from: { userid: "lisi" },
        msgtype: "text",
        text: { content: "@LaboBot 部署到测试环境" },
      },
    }),
  });
  recorder.sockets[0].emit("message", {
    data: JSON.stringify({
      payload: {
        msgid: "m_s",
        chatid: "wr_single",
        chattype: "single",
        from: { userid: "zhangsan" },
        msgtype: "text",
        text: { content: "查一下日志" },
      },
    }),
  });
  await sleep(0);
  assert.equal(received.length, 2);
  assert.equal(received[0].chatType, "group");
  assert.equal(received[0].text, "部署到测试环境");
  assert.equal(received[0].senderRef, "lisi");
  assert.equal(received[1].chatType, "p2p");
  assert.equal(received[1].text, "查一下日志");
  await adapter.disconnect();
});

test("adapter outbound: replyText chunks into ≤20480B markdown frames", async () => {
  const { recorder, adapter } = await makeConnectedAdapter();
  const bigText = "a".repeat(60000);
  await adapter.send("wr_single", { replyText: bigText });
  const frames = recorder.sockets[0].sent
    .slice(1)
    .map((f) => JSON.parse(f))
    .filter((f) => f.type === "aibot_send_msg");
  assert.ok(frames.length >= 3);
  for (const frame of frames) {
    assert.equal(frame.payload.chatid, "wr_single");
    assert.equal(frame.payload.msgtype, "markdown");
    assert.ok(Buffer.byteLength(frame.payload.markdown.content, "utf8") <= 20480);
  }
  const total = frames.map((f) => f.payload.markdown.content).join("");
  assert.equal(total, bigText);
  await adapter.disconnect();
});

test("adapter outbound: statusCard → template_card frame", async () => {
  const { recorder, adapter } = await makeConnectedAdapter();
  await adapter.send("wr_single", {
    replyText: "",
    statusCard: { title: "任务完成", status: "成功", detail: "耗时 3s" },
  });
  const frame = JSON.parse(recorder.sockets[0].sent.at(-1));
  assert.equal(frame.type, "aibot_send_msg");
  assert.equal(frame.payload.msgtype, "template_card");
  assert.equal(frame.payload.template_card.main_title.title, "任务完成");
  await adapter.disconnect();
});

test("adapter outbound before connect fails", async () => {
  const adapter = createWecomAdapter("acc-wx", { socketFactory: makeSocketRecorder().factory });
  await assert.rejects(() => adapter.send("wr_single", { replyText: "hi" }));
});

test("markdown frame builders carry the documented payload shape", () => {
  const md = JSON.parse(buildWecomMarkdownFrame({ chatRef: "wr_x", content: "# 标题" }));
  assert.equal(md.type, "aibot_send_msg");
  assert.equal(md.payload.msgtype, "markdown");
  assert.equal(md.payload.markdown.content, "# 标题");
  const card = JSON.parse(
    buildWecomTemplateCardFrame({ chatRef: "wr_x", title: "T", status: "S" }),
  );
  assert.equal(card.payload.template_card.card_type, "text_notice");
});

test("capabilities declare wecom limits (20480B markdown, 20MB files, 24h window)", () => {
  assert.equal(WECOM_CAPABILITIES.maxTextBytes, 20480);
  assert.equal(WECOM_CAPABILITIES.fileMaxBytes, 20 * 1024 * 1024);
  assert.equal(WECOM_CAPABILITIES.streaming, true);
  assert.equal(WECOM_CAPABILITIES.card, true);
  assert.equal(WECOM_CAPABILITIES.replyWindowMs, 24 * 60 * 60 * 1000);
});

test("adapter factory creates independent adapters", () => {
  const factory = createWecomAdapterFactory();
  assert.notEqual(factory("a"), factory("b"));
});
