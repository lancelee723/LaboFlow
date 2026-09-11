import assert from "node:assert/strict";
import test from "node:test";

import {
  SpaceClientError,
  createSpaceClient,
  createSpaceIpcHost,
  normalizeSpaceError,
} from "../electron/main/space-client.ts";
import { IPC } from "@pi-desktop/shared";

/** Records method+path+body and replays canned responses. */
function makeDeps(routes) {
  const calls = [];
  const respond = (method, path) => {
    const hit = routes.find(
      (route) => route.method === method && path.startsWith(route.path),
    );
    if (!hit) throw new Error(`no route for ${method} ${path}`);
    if (hit.error) throw hit.error;
    return hit.body;
  };
  return {
    calls,
    deps: {
      getJson: async (path) => {
        calls.push({ method: "GET", path });
        return respond("GET", path);
      },
      postJson: async (path, body) => {
        calls.push({ method: "POST", path, body });
        return respond("POST", path);
      },
      patchJson: async (path, body) => {
        calls.push({ method: "PATCH", path, body });
        return respond("PATCH", path);
      },
      putJson: async (path, body) => {
        calls.push({ method: "PUT", path, body });
        return respond("PUT", path);
      },
      deleteJson: async (path) => {
        calls.push({ method: "DELETE", path });
        return respond("DELETE", path);
      },
    },
  };
}

test("space client mirrors the server route family verbatim", async () => {
  const node = { id: "n1", spaceId: "s1", type: "md", name: "doc.md" };
  const comment = { id: "c1", nodeId: "n1", body: "hi" };
  const revision = { id: "r1", nodeId: "n1", status: "pending" };
  const { deps, calls } = makeDeps([
    { method: "GET", path: "/spaces", body: [{ id: "s1" }] },
    { method: "POST", path: "/spaces", body: { id: "s2" } },
    { method: "GET", path: "/spaces/s1/tree", body: [node] },
    { method: "POST", path: "/spaces/s1/nodes", body: node },
    { method: "PATCH", path: "/spaces/s1/nodes/n1", body: node },
    { method: "DELETE", path: "/spaces/s1/nodes/n1", body: { ok: true } },
    { method: "POST", path: "/spaces/s1/nodes/n1/restore", body: node },
    { method: "GET", path: "/spaces/s1/nodes/n1/doc", body: { nodeId: "n1", version: 1 } },
    { method: "PUT", path: "/spaces/s1/nodes/n1/doc", body: { nodeId: "n1", version: 2 } },
    { method: "GET", path: "/spaces/s1/nodes/n1/comments", body: [comment] },
    { method: "POST", path: "/spaces/s1/nodes/n1/comments", body: comment },
    { method: "POST", path: "/spaces/s1/nodes/n1/comments/c1/reply", body: comment },
    { method: "POST", path: "/spaces/s1/nodes/n1/comments/c1/resolve", body: comment },
    { method: "GET", path: "/spaces/s1/nodes/n1/revisions", body: [revision] },
    { method: "POST", path: "/spaces/s1/nodes/n1/revisions", body: revision },
    { method: "POST", path: "/spaces/s1/nodes/n1/revisions/r1/decide", body: revision },
    {
      method: "POST",
      path: "/spaces/s1/nodes/n1/revisions/reviewByComments",
      body: { suggestions: [revision] },
    },
    { method: "GET", path: "/spaces/s1/events?since=7", body: { events: [], lastSeq: 9 } },
  ]);
  const client = createSpaceClient(deps);

  await client.listSpaces();
  await client.createSpace({ name: "市场空间" });
  await client.tree("s1");
  await client.createNode("s1", { parentId: null, type: "md", name: "doc.md" });
  await client.renameNode("s1", "n1", "renamed.md");
  await client.moveNode("s1", "n1", null);
  await client.deleteNode("s1", "n1");
  await client.restoreNode("s1", "n1");
  await client.getDoc("s1", "n1", 3);
  await client.saveDoc("s1", "n1", { content: "正文", baseVersion: 1 });
  await client.listComments("s1", "n1");
  await client.createComment("s1", "n1", { body: "hi", anchor: null });
  await client.replyComment("s1", "n1", "c1", "回复");
  await client.resolveComment("s1", "n1", "c1", "resolved");
  await client.listRevisions("s1", "n1");
  await client.createRevision("s1", "n1", {
    anchor: { kind: "text", paraIndex: 0, textPrefix: "原", textHash: "ff" },
    originalText: "原",
    revisedText: "改",
    rationale: "理由",
    producedBy: "user",
  });
  await client.decideRevision("s1", "n1", "r1", "accepted");
  await client.reviewByComments("s1", "n1");
  await client.pullEvents("s1", 7);

  const paths = calls.map((call) => `${call.method} ${call.path}`);
  assert.deepEqual(paths, [
    "GET /spaces",
    "POST /spaces",
    "GET /spaces/s1/tree",
    "POST /spaces/s1/nodes",
    "PATCH /spaces/s1/nodes/n1",
    "PATCH /spaces/s1/nodes/n1",
    "DELETE /spaces/s1/nodes/n1",
    "POST /spaces/s1/nodes/n1/restore",
    "GET /spaces/s1/nodes/n1/doc?version=3",
    "PUT /spaces/s1/nodes/n1/doc",
    "GET /spaces/s1/nodes/n1/comments",
    "POST /spaces/s1/nodes/n1/comments",
    "POST /spaces/s1/nodes/n1/comments/c1/reply",
    "POST /spaces/s1/nodes/n1/comments/c1/resolve",
    "GET /spaces/s1/nodes/n1/revisions",
    "POST /spaces/s1/nodes/n1/revisions",
    "POST /spaces/s1/nodes/n1/revisions/r1/decide",
    "POST /spaces/s1/nodes/n1/revisions/reviewByComments",
    "GET /spaces/s1/events?since=7",
  ]);
  // optimistic-lock payload shape (server 409 EVERSION contract)
  assert.deepEqual(calls[9].body, { content: "正文", baseVersion: 1 });
  // decision payload shape
  assert.deepEqual(calls[16].body, { decision: "accepted" });
});

test("reviewByComments accepts both the wrapped and bare array shapes", async () => {
  const revision = { id: "r9", status: "pending" };
  const bare = makeDeps([
    { method: "POST", path: "/spaces/s1/nodes/n1/revisions/reviewByComments", body: [revision] },
  ]);
  assert.deepEqual(
    await createSpaceClient(bare.deps).reviewByComments("s1", "n1"),
    [revision],
  );

  const empty = makeDeps([
    { method: "POST", path: "/spaces/s1/nodes/n1/revisions/reviewByComments", body: {} },
  ]);
  assert.deepEqual(
    await createSpaceClient(empty.deps).reviewByComments("s1", "n1"),
    [],
  );
});

test("normalizeSpaceError keeps machine codes and adds readable text", () => {
  const notConnected = normalizeSpaceError(new Error("ORG_NOT_CONNECTED"));
  assert.equal(notConnected.code, "ORG_NOT_CONNECTED");

  const expired = normalizeSpaceError(new Error("ORG_EXPIRED"));
  assert.equal(expired.code, "ORG_EXPIRED");

  // index.ts wiring throws tagged fetch errors with code + status
  const conflict = normalizeSpaceError(
    Object.assign(new Error("版本冲突：服务端当前为 v3"), { code: "EVERSION", status: 409 }),
  );
  assert.equal(conflict.code, "EVERSION");
  assert.equal(conflict.status, 409);
  assert.match(conflict.message, /版本冲突/);
  assert.ok(conflict instanceof SpaceClientError);

  const plain = normalizeSpaceError(new Error("boom"));
  assert.equal(plain.message, "boom");
});

const SPACE_KEYS = [
  "spaceList", "spaceCreate", "spaceTree", "spaceNodeCreate", "spaceNodeRename",
  "spaceNodeMove", "spaceNodeDelete", "spaceNodeRestore", "spaceDocGet",
  "spaceDocSave", "spaceCommentsList", "spaceCommentsCreate",
  "spaceCommentsReply", "spaceCommentsResolve", "spaceRevisionsList",
  "spaceRevisionsCreate", "spaceRevisionsDecide", "spaceRevisionsReviewByComments",
  "spaceEventsPull", "spaceEventsSubscribe", "spaceEventsUnsubscribe",
];

function makeHostDeps(eventsHandler) {
  const client = createSpaceClient({
    getJson: async (path) => {
      if (path.startsWith("/spaces/s1/events")) {
        return eventsHandler(path);
      }
      return [];
    },
    postJson: async () => ({}),
    patchJson: async () => ({}),
    putJson: async () => ({}),
    deleteJson: async () => ({}),
  });
  const frames = [];
  const warns = [];
  const host = createSpaceIpcHost({
    client,
    emit: (frame) => frames.push(frame),
    pollMs: 15,
    warn: (context, message) => warns.push(`${context}: ${message}`),
  });
  return { host, frames, warns };
}

test("createSpaceIpcHost registers every pi-desktop/space/* handler", () => {
  const { host } = makeHostDeps(() => ({ events: [], lastSeq: 0 }));
  const registered = new Map();
  host.registerIpc((channel, fn) => registered.set(channel, fn));

  for (const key of SPACE_KEYS) {
    assert.ok(registered.has(IPC.invoke[key]), `missing handler for ${key}`);
  }
  host.stopAll();
});

test("subscribe anchors the cursor at the live tip, then forwards new frames", async () => {
  let serverSeq = 5;
  const { host, frames, warns } = makeHostDeps(() => ({
    events: Array.from({ length: serverSeq - 4 }, (_, i) => ({
      seq: 5 + i,
      type: "doc.version",
      payload: { nodeId: "n1", version: i + 1 },
      actorId: "u1",
      createdAt: "2026-09-11T00:00:00Z",
    })).filter((event) => event.seq <= serverSeq),
    lastSeq: serverSeq,
  }));
  const registered = new Map();
  host.registerIpc((channel, fn) => registered.set(channel, fn));

  // Initial pull learns lastSeq=5 WITHOUT replaying history.
  await registered.get(IPC.invoke.spaceEventsSubscribe)({ spaceId: "s1" });
  assert.equal(frames.length, 0);

  // A later event lands on the server; the poll loop forwards it as a frame.
  serverSeq = 6;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(frames.length >= 1, "expected at least one forwarded frame");
  const frame = frames[frames.length - 1];
  assert.equal(frame.spaceId, "s1");
  assert.equal(frame.type, "doc.version");
  assert.equal(frame.seq, 6);
  assert.deepEqual(frame.payload, { nodeId: "n1", version: 2 });
  assert.equal(frame.actorId, "u1");
  assert.ok(Array.isArray(warns) === true);

  host.stopAll();
  const count = frames.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(frames.length, count, "stopAll must stop the poll loop");
});

test("unsubscribe via IPC stops a single poller and poll errors warn quietly", async () => {
  let failing = false;
  const { host, warns } = makeHostDeps(() => {
    if (failing) throw new Error("ORG_API_FAILED: HTTP 503");
    return { events: [], lastSeq: 0 };
  });
  const registered = new Map();
  host.registerIpc((channel, fn) => registered.set(channel, fn));

  await registered.get(IPC.invoke.spaceEventsSubscribe)({ spaceId: "s1" });
  failing = true;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(
    warns.some((entry) => entry.startsWith("space:")),
    "poll failures must hit the warn sink",
  );

  const result = await registered.get(IPC.invoke.spaceEventsUnsubscribe)({ spaceId: "s1" });
  assert.deepEqual(result, { ok: true });
  host.stopAll();
});
