import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  createWebhookServer,
  secretMatches,
  hmacSignature,
} = await import("../electron/main/assistant/im-server.ts");

const SECRET = "wf_test_secret";

function fakeRunner(delayMs, reply = "完成：已生成摘要") {
  return async ({ signal }) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
    return { reply, files: [] };
  };
}

async function startServer(overrides = {}) {
  const server = createWebhookServer({
    config: { secret: SECRET, port: 0, lanOpen: false, syncBudgetMs: 500, ...overrides },
    runner: overrides.runner ?? fakeRunner(20),
    ...(overrides.listSchedules ? { listSchedules: overrides.listSchedules } : {}),
  });
  const port = await server.start();
  return { server, base: `http://127.0.0.1:${port}` };
}

test("secret comparison is constant-time semantics: equal passes, length-mismatch fails", () => {
  assert.equal(secretMatches(SECRET, SECRET), true);
  assert.equal(secretMatches("wrong", SECRET), false);
  assert.equal(secretMatches("shorter", SECRET), false);
  assert.equal(hmacSignature("body", SECRET).length, 64);
});

test("sync path returns reply within budget; wrong secret is 401", async () => {
  const { server, base } = await startServer();
  try {
    const bad = await fetch(`${base}/im/task`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ message: "hi" }),
    });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${base}/im/task`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ message: "汇总今天的纪要" }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.match(body.reply, /完成/);
    assert.deepEqual(body.files, []);
  } finally {
    await server.stop();
  }
});

test("long tasks flip to 202 + taskId and the status endpoint converges", async () => {
  const { server, base } = await startServer({ runner: fakeRunner(1500) });
  try {
    const res = await fetch(`${base}/im/task`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ message: "长任务" }),
    });
    assert.equal(res.status, 202);
    const { taskId } = await res.json();
    assert.ok(taskId);
    const poll = await fetch(`${base}/im/task/${taskId}`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const pollBody = await poll.json();
    assert.equal(pollBody.state, "running");
    await new Promise((resolve) => setTimeout(resolve, 1700));
    const done = await fetch(`${base}/im/task/${taskId}`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const doneBody = await done.json();
    assert.equal(doneBody.state, "succeeded");
    assert.match(doneBody.reply, /完成/);
  } finally {
    await server.stop();
  }
});

test("SSE stream delivers the completion event", async () => {
  const { server, base } = await startServer({ runner: fakeRunner(1500), syncBudgetMs: 100 });
  try {
    const res = await fetch(`${base}/im/task`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ message: "sse" }),
    });
    const { taskId } = await res.json();
    const controller = new AbortController();
    const stream = fetch(`${base}/im/task/${taskId}/events`, {
      headers: { authorization: `Bearer ${SECRET}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = [];
    const reader = (await stream).body.getReader();
    const read = async () => {
      const { value, done } = await reader.read();
      if (!done) events.push(Buffer.from(value).toString("utf8"));
    };
    const readPromise = read();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await readPromise.catch(() => undefined);
    controller.abort();
    assert.ok(events.some((chunk) => chunk.includes('"type":"completed"')), events.join("|"));
  } finally {
    await server.stop();
  }
});

test("empty message is 422; unknown path 404; schedules surface through the same auth", async () => {
  let listCalled = 0;
  const { server, base } = await startServer({
    listSchedules: async () => {
      listCalled += 1;
      return { tasks: [{ id: "t1" }] };
    },
  });
  try {
    const empty = await fetch(`${base}/im/task`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ message: "  " }),
    });
    assert.equal(empty.status, 422);
    const missing = await fetch(`${base}/nope`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(missing.status, 404);
    const schedules = await fetch(`${base}/api/schedules`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(schedules.status, 200);
    assert.deepEqual((await schedules.json()).tasks, [{ id: "t1" }]);
    assert.equal(listCalled, 1);
  } finally {
    await server.stop();
  }
});
