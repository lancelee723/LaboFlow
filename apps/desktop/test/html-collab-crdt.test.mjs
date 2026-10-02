import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as ts from "typescript";

// Same CJS copies the transpiled connector sees — yjs breaks constructor
// checks (and integrates nothing) across duplicated module instances.
const nodeRequire = createRequire(import.meta.url);
const Y = nodeRequire("yjs");
const awarenessProtocol = nodeRequire("y-protocols/awareness");
const encoding = nodeRequire("lib0/encoding");
const decoding = nodeRequire("lib0/decoding");
const syncProtocol = nodeRequire("y-protocols/sync");
const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** Transpile the connector (CommonJS) against an injected api mock; the other
 * imports (yjs, lib0, y-protocols) resolve to the real packages. */
function loadConnector(apiMock) {
  const { outputText } = ts.transpileModule(read("../src/lib/yjs-ipc-connector.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: "yjs-ipc-connector.ts",
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    if (id === "./api") return { api: apiMock };
    return nodeRequire(id);
  }, module.exports, module);
  return module.exports;
}

/** In-memory twin of the main-process bridge: routes binary frames between
 * two connector sessions so the real protocol loop runs unmocked. */
function fakeBridge(apiMock) {
  const listeners = new Map();
  const sent = new Map();
  let channelCounter = 0;
  apiMock.spaceYjsAttach = async () => ({ channel: `ch-${++channelCounter}` });
  apiMock.spaceYjsDetach = async () => ({ ok: true });
  apiMock.spaceYjsSend = async (input) => {
    sent.set(input.channel, [...(sent.get(input.channel) ?? []), input.data]);
    return { ok: true };
  };
  apiMock.onSpaceYjsFrame = (listener) => {
    listeners.set(`ch-${channelCounter}`, listener);
    return () => listeners.delete(`ch-${channelCounter}`);
  };
  return {
    /** Deliver one side's queued frames to the other side's listener. */
    flush(fromChannel, toChannel) {
      for (const data of sent.get(fromChannel) ?? []) {
        listeners.get(toChannel)?.({ channel: toChannel, data: data.slice(0) });
      }
      sent.set(fromChannel, []);
    },
  };
}

test("two docs converge over the ipc connector (sync + updates)", async () => {
  const apiMock = {};
  const bridge = fakeBridge(apiMock);
  const { connectYjsOverIpc } = loadConnector(apiMock);

  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const awarenessA = new awarenessProtocol.Awareness(docA);
  const awarenessB = new awarenessProtocol.Awareness(docB);

  // Attach order fixes channel ids: A=ch-1, B=ch-2.
  const connA = await connectYjsOverIpc({ spaceId: "s", nodeId: "n", doc: docA, awareness: awarenessA });
  const connB = await connectYjsOverIpc({ spaceId: "s", nodeId: "n", doc: docB, awareness: awarenessB });

  docA.getMap("html").set("title", "验收协同");
  bridge.flush("ch-1", "ch-2"); // A's syncStep1 + update → B
  bridge.flush("ch-2", "ch-1"); // B's syncStep1 + reply → A
  bridge.flush("ch-1", "ch-2"); // A's step2 → B
  assert.equal(docB.getMap("html").get("title"), "验收协同");

  // Concurrent edits on independent keys merge without loss.
  docA.getMap("html").set("a", 1);
  docB.getMap("html").set("b", 2);
  bridge.flush("ch-1", "ch-2");
  bridge.flush("ch-2", "ch-1");
  bridge.flush("ch-1", "ch-2");
  assert.equal(docA.getMap("html").get("a"), 1);
  assert.equal(docA.getMap("html").get("b"), 2);
  assert.equal(docB.getMap("html").get("a"), 1);
  assert.equal(docB.getMap("html").get("b"), 2);

  await connA.detach();
  await connB.detach();
  awarenessA.destroy();
  awarenessB.destroy();
});

test("blocksToHtml escapes text and keeps block semantics", async () => {
  const { outputText } = ts.transpileModule(read("../src/components/space/HtmlCollabEditor.tsx"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: "HtmlCollabEditor.tsx",
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    if (id.startsWith(".")) {
      // Relative UI imports are irrelevant to the serializer; stub them.
      return new Proxy(function () {}, { get: () => () => null });
    }
    return nodeRequire(id);
  }, module.exports, module);
  const { blocksToHtml } = module.exports;
  const html = blocksToHtml([
    { id: "1", type: "h1", text: "标题<b>", src: "" },
    { id: "2", type: "bullet", text: "要点", src: "" },
    { id: "3", type: "image", text: "", src: "https://example.com/x.png" },
    { id: "4", type: "chart", text: "series-1", src: "" },
    { id: "5", type: "paragraph", text: "A & B", src: "" },
  ]);
  assert.match(html, /<h1>标题&lt;b&gt;<\/h1>/);
  assert.match(html, /<ul><li>要点<\/li><\/ul>/);
  assert.match(html, /<figure><img src="https:\/\/example\.com\/x\.png"/);
  assert.match(html, /<figure class="chart" data-series="series-1">/);
  assert.match(html, /<p>A &amp; B<\/p>/);
  assert.match(html, /<!doctype html>/);
});

test("sync wire frames use the same envelope as the hub expects", () => {
  const doc = new Y.Doc();
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0); // MESSAGE_SYNC
  syncProtocol.writeSyncStep1(encoder, doc);
  const bytes = encoding.toUint8Array(encoder);
  const decoder = decoding.createDecoder(bytes);
  assert.equal(decoding.readVarUint(decoder), 0);
  // Sync payload is inline; a readSyncMessage consumer must see step1 next.
  assert.equal(decoding.readVarUint(decoder), syncProtocol.messageYjsSyncStep1);
});
