import assert from "node:assert/strict";
import test from "node:test";

import { buildExpertDispatchTask } from "../src/lib/expert-dispatch.ts";

test("envelope passes a bare task through untouched", () => {
  const task = "梳理这份竞品数据并给出结论";
  assert.equal(buildExpertDispatchTask(task), task);
  assert.equal(buildExpertDispatchTask(task, null), task);
  assert.equal(buildExpertDispatchTask(task, { fileReferences: [] }), task);
});

test("envelope lists attached file paths as readable context", () => {
  const out = buildExpertDispatchTask("分析附件中的营收数据", {
    fileReferences: [
      { path: "reports/2026 revenue.xlsx" },
      { path: "/tmp/scratch/session-abc.md" },
    ],
  });
  assert.match(out, /^分析附件中的营收数据/);
  assert.match(out, /\[上下文\]/);
  assert.match(out, /- reports\/2026 revenue\.xlsx/);
  assert.match(out, /- \/tmp\/scratch\/session-abc\.md/);
  // Context trails the prompt so the task itself stays first.
  assert.ok(out.indexOf("分析附件中的营收数据") < out.indexOf("[上下文]"));
});

test("envelope ignores references without paths", () => {
  const out = buildExpertDispatchTask("任务", {
    fileReferences: [{ path: "" }, {}],
  });
  assert.equal(out, "任务");
});
