/**
 * FR-KB-05 + FR-KB-14: multi-service routing clause and the per-day
 * retrieval usage meter. Pure logic plus the wiring seams (session-launch
 * feeds clauses from the SAME active MCP records; host.ts meters the mcp_
 * call path; the usage page reads the ledger back).
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { kbRetrievalServers, buildKbRoutingClause, kbToolGuidanceClauses } =
  await import("../electron/main/laboflow/kb-routing.ts");
const {
  isKbToolName,
  isKbServerId,
  estimateKbTokens,
  recordKbToolCall,
  rollKbLedger,
  kbUsageHistory,
  KB_USAGE_MAX_DAYS,
  createKbUsageMeter,
} = await import("../electron/main/laboflow/kb-usage.ts");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const RECORDS = [
  { id: "kb-customer", label: "客户资料库", description: "客户年报与制度", source: "org" },
  { id: "kb-industry", label: "行业数据库", description: "", source: "org" },
  { id: "web-search", label: "Web search", source: undefined },
  { id: "mcp-filething", label: "file thing", source: "org" },
];

test("routing clause lists only the fork's retrieval services, from two up", () => {
  const servers = kbRetrievalServers(RECORDS);
  assert.deepEqual(
    servers.map((server) => server.id),
    ["kb-customer", "kb-industry"],
  );
  assert.equal(buildKbRoutingClause(servers.slice(0, 1)), undefined, "single service needs no clause");
  const clause = buildKbRoutingClause(servers);
  assert.match(clause, /客户资料库/);
  assert.match(clause, /行业数据库/);
  assert.match(clause, /按名称/);
  assert.match(clause, /MCP 工具审批/);
  // Non-KB MCP servers never enter the clause.
  assert.doesNotMatch(clause, /Web search|filething/);
  // The launch seam: clauses array is empty or single, never more.
  const clauses = kbToolGuidanceClauses(RECORDS);
  assert.equal(clauses.length, 1);
});

test("tool names gate kb servers; the registry owns the id, not the name", () => {
  assert.equal(isKbToolName("mcp_kb-customer_hybrid_search"), true);
  assert.equal(isKbToolName("mcp_web_search_query"), false);
  // Names are not parseable (ids contain underscores) — callers pass the
  // registry's server id, and only kb- prefixed ones fold into the ledger.
  assert.equal(isKbServerId("kb-customer"), true);
  assert.equal(isKbServerId("web-search"), false);
  assert.equal(isKbServerId(undefined), false);
});

test("the ledger folds calls per day and rolls off beyond the window", () => {
  const now = new Date("2026-10-17T12:00:00");
  let ledger = recordKbToolCall(undefined, {
    serverId: "kb-customer",
    ok: true,
    args: { q: "2024 年报" },
    result: "收入结构：……".repeat(20),
    now,
  });
  ledger = recordKbToolCall(ledger, {
    serverId: "kb-customer",
    ok: false,
    args: { q: "x" },
    result: { error: "timeout" },
    now,
  });
  const [today] = kbUsageHistory(ledger);
  assert.equal(today.calls, 2);
  assert.equal(today.errors, 1);
  assert.equal(today.byServer["kb-customer"].calls, 2);
  assert.ok(today.totalTokens > 0);
  // House heuristic: 4 chars per token, arguments and results summed.
  const estimate = estimateKbTokens("abcd", "abcdefgh");
  assert.deepEqual(estimate, { argumentTokens: 1, resultTokens: 2, totalTokens: 3 });

  // Rolling: a day older than the window is dropped.
  const old = new Date(now);
  old.setDate(old.getDate() - KB_USAGE_MAX_DAYS);
  ledger = recordKbToolCall(ledger, {
    serverId: "kb-industry",
    ok: true,
    args: null,
    result: "r",
    now: old,
  });
  const rolled = rollKbLedger(ledger, now);
  assert.equal(rolled.days[old.toISOString().slice(0, 10)], undefined);
  assert.ok(rolled.days["2026-10-17"]);
});

test("the meter coalesces writes and only meters kb tools", async () => {
  let loads = 0;
  let saves = 0;
  let saved = null;
  const meter = createKbUsageMeter({
    load: async () => {
      loads += 1;
      return undefined;
    },
    save: async (ledger) => {
      saves += 1;
      saved = ledger;
    },
  });
  meter.record({ fullName: "mcp_web_search_query", serverId: "web-search", ok: true, args: null, result: "ignored" });
  meter.record({ fullName: "mcp_kb-a_search", serverId: "kb-a", ok: true, args: "abcd", result: "abcdefghij" });
  meter.record({ fullName: "mcp_kb-a_search", serverId: "kb-a", ok: true, args: "abcd", result: "abcdefghij" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(loads, 1, "ledger loads once");
  await meter.flush();
  assert.equal(saves, 1, "writes coalesce");
  assert.equal(saved.days && Object.keys(saved.days).length, 1);
  const entry = Object.values(saved.days)[0];
  assert.equal(entry.calls, 2);
});

test("launch passes the clause as toolGuidanceClauses; host meters the mcp path", async () => {
  const launch = await read("../electron/main/runtime/session-launch.ts");
  assert.match(launch, /kbToolGuidanceClauses\(userMcp\.listRecords\(\)\)/);
  assert.match(launch, /toolGuidanceClauses: kbRoutingClauses/);
  const host = await read("../electron/main/runtime/host.ts");
  assert.match(host, /createKbUsageMeter\(/);
  assert.match(
    host,
    /kbUsageMeter\?\.record\(\{\s*fullName: q\.toolName,\s*serverId: userMcp\.serverIdForTool\(q\.toolName\)/,
  );
  // Page reads it back; the section renders only when calls exist.
  const page = await read("../src/components/settings/TokenUsagePage.tsx");
  assert.match(page, /\.kbUsageHistory\(\)/);
  assert.match(page, /kbStats\.calls > 0/);
});
