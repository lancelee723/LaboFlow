import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const search = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const settingsPage = await readFile(
  new URL("../src/pages/SettingsPage.tsx", import.meta.url),
  "utf8",
);
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

test("usage page component renders cards, heatmap, trend, and table", () => {
  assert.match(usagePage, /usage-cards/);
  assert.match(usagePage, /usage-heatmap/);
  assert.match(usagePage, /usage-chart/);
  assert.match(usagePage, /usage-table/);
  assert.match(usagePage, /getTokenUsageHistory/);
});

test("usage page component exists on disk", async () => {
  await access(
    new URL("../src/components/settings/TokenUsagePage.tsx", import.meta.url),
    constants.F_OK,
  );
});
