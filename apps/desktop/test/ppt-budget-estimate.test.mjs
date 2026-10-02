import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const { estimateDeckTokens, budgetVerdict, TOKENS_PER_PAGE, BASE_OVERHEAD_TOKENS } =
  nodeRequire("../resources/plugins/laboflow.slides/lib/ppt-estimate.js");

test("estimate scales per page over a fixed overhead", () => {
  assert.equal(estimateDeckTokens(0), BASE_OVERHEAD_TOKENS);
  assert.equal(estimateDeckTokens(3), BASE_OVERHEAD_TOKENS + 3 * TOKENS_PER_PAGE);
});

test("budget verdict refuses over-budget decks with a structured code", () => {
  const within = budgetVerdict(3, 600_000);
  assert.equal(within.ok, true);
  const over = budgetVerdict(30, 600_000);
  assert.equal(over.ok, false);
  assert.equal(over.code, "PPT_BUDGET_EXCEEDED");
  assert.ok(over.estimate > over.budget);
});

test("missing budget means unlimited", () => {
  assert.equal(budgetVerdict(500, undefined).ok, true);
  assert.equal(budgetVerdict(500, 0).ok, true);
});
