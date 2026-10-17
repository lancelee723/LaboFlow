/**
 * FR-MC-11/17: task-level fields — per-task catch-up toggle, unattended
 * policy, and the MC-15 output destination — persist through the host
 * config_json path (validated and covered by the Rust suite); this pins the
 * renderer half: what the editor saves and when the fields are offered.
 * The runner half (policy arming the launched session) lives in
 * scheduled-runner.test.mjs.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [editor, shared, en, zhCN] = await Promise.all([
  read("../src/features/scheduled/ScheduledEditor.tsx"),
  read("../../../packages/shared/src/types/platform.ts"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
]);

test("the editor saves all three task-level fields", () => {
  const save = editor.match(/void save\(\{[\s\S]*?\}\);/)?.[0] ?? "";
  assert.match(save, /outputDestination: outputDestination \|\| null/);
  assert.match(save, /catchUpEnabled: cadence === "cron" \? catchUpEnabled : null/);
  assert.match(
    save,
    /policyTouched \|\| task\?\.unattendedPolicy \? unattendedPolicy : null/,
  );
});

test("catch-up is a cron-only toggle defaulting to on; policy offers the three tiers", () => {
  assert.match(editor, /useState\(task\?\.catchUpEnabled \?\? true\)/);
  assert.match(editor, /cadence === "cron" && \(/);
  assert.match(editor, /type="checkbox"/);
  assert.match(editor, /value="strict"/);
  assert.match(editor, /value="degraded"/);
  assert.match(editor, /value="lenient"/);
});

test("the wire type carries the fields for renderer and host", () => {
  assert.match(shared, /catchUpEnabled\?: boolean \| null/);
  assert.match(shared, /unattendedPolicy\?: "strict" \| "degraded" \| "lenient" \| null/);
  assert.match(shared, /outputDestination\?: string \| null/);
});

test("labels exist in both source and mirror locales", () => {
  assert.match(en, /catchUp: "Catch up missed runs/);
  assert.match(en, /unattendedPolicy: "Unattended permission policy"/);
  assert.match(zhCN, /catchUp: "错过后补跑/);
  assert.match(zhCN, /unattendedPolicy: "无人值守权限策略"/);
});
