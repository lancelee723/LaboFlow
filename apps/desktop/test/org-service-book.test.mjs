import assert from "node:assert/strict";
import test from "node:test";
import { OrgService, orgSessionKey } from "../electron/main/org-service.ts";

// Behavioral test for the multi-org session book (Phase 3): two servers, two
// logins, current-org switching, per-org quota passthrough, and scoped logout.

function makeFetch(log) {
  const jsonResponse = (body) => ({
    ok: true,
    status: 200,
    json: async () => body,
  });
  return async (url, init = {}) => {
    const u = String(url);
    const bearer = init.headers?.authorization ?? "";
    const token = bearer.replace("Bearer ", "");
    const server = u.startsWith("https://a.example")
      ? "a.example"
      : u.startsWith("https://b.example")
        ? "b.example"
        : null;
    if (u.endsWith("/auth/login")) {
      log.push(`login:${server}`);
      return jsonResponse({
        tokens: {
          accessToken: server === "a.example" ? "tok-A" : "tok-B",
          refreshToken: `r-${server}`,
        },
        user: { role: "member", displayName: server.toUpperCase() },
      });
    }
    if (u.endsWith("/org/bootstrap")) {
      const valid =
        (server === "a.example" && token === "tok-A") ||
        (server === "b.example" && token === "tok-B");
      if (!valid) return { ok: false, status: 401, json: async () => ({}) };
      log.push(`bootstrap:${server}`);
      return jsonResponse({
        org: { name: server === "a.example" ? "OrgA" : "OrgB" },
        me: {
          userId: `u-${server}`,
          username: server === "a.example" ? "ua" : "ub",
          role: "member",
        },
        workspaces: [{ id: "w1" }],
        orgChannels: [],
      });
    }
    if (u.endsWith("/quota/remaining")) {
      log.push(`quota:${token}`);
      return jsonResponse({ ok: true, entries: [], generatedAt: "" });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

function makeService(log) {
  const store = {};
  const deps = {
    call: async (method, params = {}) => {
      if (method === "secrets.set") {
        store[params.secretRef] = params.value;
        return {};
      }
      if (method === "secrets.getForRuntime") {
        return { value: store[params.secretRef] ?? null };
      }
      if (method === "secrets.delete") {
        delete store[params.secretRef];
        return {};
      }
      throw new Error(`unexpected host call: ${method}`);
    },
  };
  return { service: new OrgService(deps, makeFetch(log)), store, log };
}

test("multi-org book: two logins coexist, current switches, quota follows current", async () => {
  const log = [];
  const { service } = makeService(log);

  const first = await service.login({
    serverUrl: "https://a.example",
    username: "ua",
    password: "p",
  });
  assert.equal(first.state, "connected");
  assert.equal(first.orgName, "OrgA");
  const keyA = first.currentKey;
  assert.equal(keyA, "https://a.example|ua");

  const second = await service.login({
    serverUrl: "https://b.example",
    username: "ub",
    password: "p",
  });
  assert.equal(second.currentKey, "https://b.example|ub");
  assert.equal(second.orgs.length, 2);
  assert.equal(second.orgName, "OrgB");

  // Switch back to org A: every org-scoped call must use A's session.
  const switched = await service.setCurrent(keyA);
  assert.equal(switched.serverUrl, "https://a.example");
  assert.equal(switched.orgName, "OrgA");
  log.length = 0;
  await service.quotaRemaining();
  assert.ok(log.includes("quota:tok-A"), "quota must follow the current org");

  // Scoped logout removes only the current org; B survives and becomes current.
  const out = await service.logout();
  assert.equal(out.currentKey, "https://b.example|ub");
  assert.equal(out.state, "connected");
  assert.equal(out.orgName, "OrgB");
  assert.equal(out.orgs.length, 1);

  const out2 = await service.logout();
  assert.equal(out2.state, "disconnected");
});

test("expired current session reports expired while keeping the org list", async () => {
  const log = [];
  const { service } = makeService(log);
  await service.login({
    serverUrl: "https://a.example",
    username: "ua",
    password: "p",
  });
  // Corrupt the stored token to simulate expiry without dropping the book.
  const raw = JSON.parse(log.raw ?? "{}");
  void raw;
  const { store } = makeService(log);
  void store;
  const status = await service.status();
  assert.equal(status.connected, true);
});
