import { readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const search = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const settingsPage = await readSettingsSource();
const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const usagePage = await readFile(
  new URL("../src/components/settings/TokenUsagePage.tsx", import.meta.url),
  "utf8",
);

/**
 * LaboFlow pivot decision (docs/laboflow/02-org-integration-plan.md): a
 * first-party usage stats page returns to Settings, fed by the host-owned
 * completed-turn token history (ADR 0171). Upstream ADR 0173 deliberately
 * shipped without one; the fork overrides that for the consulting workflow.
 */
test("settings exposes a usage destination backed by host token history", () => {
  assert.match(search, /id: "usage"/);
  assert.match(search, /settings\.nav\.usage/);
  assert.match(settingsPage, /TokenUsagePage/);
  assert.match(settingsPage, /tab === "usage"/);
  assert.match(api, /getTokenUsageHistory/);
});

/**
 * The usage stats page is a second view of the Token Insights plugin: it
 * reads the plugin's live fact cube first and falls back to host turn
 * history only when the plugin is absent.
 */
test("usage page renders the Token Insights fact cube with host fallback", () => {
  assert.match(api, /getTokenInsights/);
  assert.match(usagePage, /usageFromTokenInsightsFacts/);
  assert.match(usagePage, /setDataSource\("plugin"\)/);
  assert.match(usagePage, /setDataSource\("host"\)/);
  assert.match(usagePage, /hostTurnCount/);
});

test("usage page component renders cards, heatmap, and trend", () => {
  assert.match(usagePage, /usage-cards/);
  assert.match(usagePage, /usage-heatmap/);
  assert.match(usagePage, /usage-chart/);
  assert.match(usagePage, /getTokenUsageHistory/);
});

/**
 * ZCode-parity usage stats: the activity heatmap switches between daily,
 * weekly and cumulative granularities via a capsule control, hovered cells
 * show a bold border with a floating detail card, the trend chart draws one
 * rounded line per model, and the old daily-breakdown table is gone.
 */
test("usage page has daily/weekly/cumulative heat modes with hover details", () => {
  assert.match(usagePage, /heatDay/);
  assert.match(usagePage, /heatWeek/);
  assert.match(usagePage, /heatCumulative/);
  assert.match(usagePage, /usage-heat-tooltip/);
  assert.match(usagePage, /is-hover/);
  assert.match(usagePage, /smoothPath/);
});

test("month axis labels span their month's real grid columns", () => {
  assert.match(usagePage, /start: number; end: number/);
  assert.match(usagePage, /gridColumn: `\$\{month\.start \+ 1\} \/ \$\{month\.end \+ 2\}`/);
});

test("usage trend chart is per-model with no daily-breakdown table", () => {
  assert.match(usagePage, /usage-chart-legend-dot/);
  assert.match(usagePage, /modelSeries/);
  assert.doesNotMatch(usagePage, /usage-table/);
  assert.doesNotMatch(usagePage, /dailyBreakdown/);
});

/**
 * Trend line rendering: each model's color must be an inline style (CSS class
 * rules override SVG presentation attributes, which painted every line with
 * the text color), and the spline must be monotone so spiky days cannot push
 * the curve outside the chart frame.
 */
test("trend lines keep per-model colors and never leave the chart frame", () => {
  assert.match(usagePage, /style=\{\{ stroke: series\.color \}\}/);
  assert.match(usagePage, /Fritsch–Carlson/);
  assert.match(usagePage, /CHART_PAD = 12/);
});

/**
 * ZCode-parity trend extras: localized date ticks under the axis (9月12日 /
 * Sep 12 via Intl), a hover card listing every model's usage for the hovered
 * day, no date suffix in the legend, and a cumulative per-model donut below.
 */
test("trend chart has date ticks, hover card, and legend without date suffix", () => {
  assert.match(usagePage, /usage-tick/);
  assert.match(usagePage, /usage-trend-tooltip/);
  assert.match(usagePage, /Intl\.DateTimeFormat/);
  assert.match(usagePage, /usage-chart-hover-line/);
  assert.doesNotMatch(usagePage, /keys\[0\] ~ /);
});

test("a cumulative per-model donut follows the trend chart", () => {
  assert.match(usagePage, /usage-donut/);
  assert.match(usagePage, /usage-donut-seg/);
  assert.match(usagePage, /modelUsage/);
  assert.match(usagePage, /modelTotalsSum/);
});

test("usage page component exists on disk", async () => {
  await access(
    new URL("../src/components/settings/TokenUsagePage.tsx", import.meta.url),
    constants.F_OK,
  );
});
