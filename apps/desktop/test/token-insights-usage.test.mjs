import assert from "node:assert/strict";
import test from "node:test";

import { usageFromTokenInsightsFacts } from "../src/lib/token-insights.ts";

/**
 * The usage stats page renders the Token Insights plugin's published fact
 * cube. These tests pin the re-bucketing contract: rows fold into per-day
 * totals and per-model series, models rank heaviest-first, and malformed or
 * empty cubes yield null so the page falls back to host history.
 */
const cube = {
  available: true,
  generatedAt: 1_789_178_293_161,
  columns: [
    "day", "hour", "source", "model", "provider", "session",
    "messages", "input", "output", "cacheRead", "cacheWrite", "reasoning", "total",
  ],
  days: ["2026-09-10", "2026-09-11"],
  models: ["glm-5.3", "glm-5.3-flash"],
  // Token Insights ships source entries as {id, label} objects.
  sources: [
    { id: "pi-desktop", label: "PI-Desktop" },
    { id: "claude-code", label: "Claude Code" },
  ],
  buckets: [
    // day, hour, source, model, provider, session, messages, input, output, cacheRead, cacheWrite, reasoning, total
    [0, 20, 0, 1, 0, 0, 5, 1000, 200, 3000, 0, 0, 4200],
    [0, 21, 0, 0, 0, 0, 3, 500, 100, 0, 0, 0, 600],
    [1, 9, 0, 1, 0, 1, 8, 2000, 400, 1000, 0, 50, 3450],
    // A row from another tool on the machine (Claude Code with DeepSeek).
    [0, 22, 1, 0, 1, 2, 40, 90000, 9000, 0, 0, 0, 99000],
  ],
};

test("fact cube folds rows into per-day totals", () => {
  const usage = usageFromTokenInsightsFacts(cube, { sourceId: "pi-desktop" });
  assert.ok(usage);
  assert.equal(usage.items.length, 2);
  const first = usage.items.find((item) => item.date === "2026-09-10");
  assert.equal(first?.inputTokens, 1500);
  assert.equal(first?.outputTokens, 300);
  assert.equal(first?.cacheReadTokens, 3000);
  assert.equal(first?.totalTokens, 4800);
  const second = usage.items.find((item) => item.date === "2026-09-11");
  assert.equal(second?.totalTokens, 3450);
});

/**
 * The usage stats page counts only this app's own usage. The plugin's cube
 * also folds in other tools on the machine (Claude Code with DeepSeek in the
 * fixture) — those rows must vanish when a source scope is given.
 */
test("source scope drops other tools' rows", () => {
  const scoped = usageFromTokenInsightsFacts(cube, { sourceId: "pi-desktop" });
  assert.ok(scoped);
  assert.equal(scoped.items.length, 2);
  const first = scoped.items.find((item) => item.date === "2026-09-10");
  assert.equal(first?.totalTokens, 4800);
  assert.deepEqual(
    scoped.models.map((model) => model.modelId),
    ["glm-5.3-flash", "glm-5.3"],
  );

  const unscoped = usageFromTokenInsightsFacts(cube);
  assert.ok(unscoped);
  const unscopedFirst = unscoped.items.find((item) => item.date === "2026-09-10");
  assert.equal(unscopedFirst?.totalTokens, 103800);
  assert.ok(unscoped.models.some((model) => model.modelId === "glm-5.3"));

  // An unknown scope matches nothing → null (page falls back to host data).
  assert.equal(usageFromTokenInsightsFacts(cube, { sourceId: "codex" }), null);
});

test("fact cube yields per-model series ranked heaviest first", () => {
  const usage = usageFromTokenInsightsFacts(cube, { sourceId: "pi-desktop" });
  assert.ok(usage);
  assert.equal(usage.models.length, 2);
  // glm-5.3-flash: 4200 + 3450 = 7650 > glm-5.3: 600 → leads the legend.
  assert.equal(usage.models[0].modelId, "glm-5.3-flash");
  assert.equal(usage.models[0].items.length, 2);
  assert.equal(usage.models[0].items[0].totalTokens, 4200);
  assert.equal(usage.models[1].modelId, "glm-5.3");
  assert.equal(usage.models[1].items[0].totalTokens, 600);
});

test("malformed or empty cubes return null so the page falls back", () => {
  assert.equal(usageFromTokenInsightsFacts(null), null);
  assert.equal(usageFromTokenInsightsFacts({ available: false }), null);
  assert.equal(usageFromTokenInsightsFacts({ available: true, columns: [], buckets: [] }), null);
  assert.equal(
    usageFromTokenInsightsFacts({
      available: true,
      columns: ["hour"],
      days: ["2026-09-10"],
      models: [],
      buckets: [[0]],
    }),
    null,
  );
});
