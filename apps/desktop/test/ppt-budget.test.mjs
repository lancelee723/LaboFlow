/**
 * FR-PPT-16: generation cost estimate + page budget.
 * Pure heuristics plus the submit-path persistence contract.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildEstimate,
  estimateCost,
  evaluateBudget,
  pageCountFromRecommendations,
} from "../resources/plugins/laboflow.slides/lib/ppt-budget.js";
import { submitStage, loadState } from "../resources/plugins/laboflow.slides/lib/ppt-state.js";

test("pageCountFromRecommendations reads every agent shape", () => {
  assert.equal(pageCountFromRecommendations({ page_count: 12 }), 12);
  assert.equal(pageCountFromRecommendations({ pageCount: 8 }), 8);
  assert.equal(pageCountFromRecommendations({ pages: [{}, {}, {}] }), 3);
  assert.equal(pageCountFromRecommendations({ directions: [{ name: "a" }, { page_count: 15 }] }), 15);
  assert.equal(pageCountFromRecommendations({ roster: { P01: 1, P02: 2, P03: 3, P04: 4 } }), 4);
  assert.equal(pageCountFromRecommendations({ page_count: 9999 }), null, "absurd counts rejected");
  assert.equal(pageCountFromRecommendations("junk"), null);
  assert.equal(pageCountFromRecommendations(undefined), null);
});

test("estimateCost scales linearly per engine", () => {
  const l2 = estimateCost({ pages: 30, engine: "L2" });
  assert.equal(l2.tokensTotal, 30 * 23_000);
  const l1 = estimateCost({ pages: 30, engine: "L1" });
  assert.equal(l1.tokensTotal, 30 * 3_000);
  assert.equal(estimateCost({ pages: 0 }).tokensTotal, 0);
});

test("evaluateBudget: no budget configured never exceeds", () => {
  assert.deepEqual(evaluateBudget({ pages: 100, budgetPages: null }), {
    budget: null,
    exceeds: false,
    ratio: null,
  });
  assert.equal(evaluateBudget({ pages: 45, budgetPages: 30 }).exceeds, true);
  assert.equal(evaluateBudget({ pages: 30, budgetPages: 30 }).exceeds, false);
  assert.equal(evaluateBudget({ pages: 45, budgetPages: 30 }).ratio, 1.5);
});

test("buildEstimate combines the shapes and marks the overrun", () => {
  const verdict = buildEstimate({ recommendations: { page_count: 45 }, budgetPages: 30 });
  assert.equal(verdict.pages, 45);
  assert.equal(verdict.budget.exceeds, true);
  assert.ok(verdict.estimate.tokensTotal > 0);
  const unknown = buildEstimate({ recommendations: {}, budgetPages: 30 });
  assert.equal(unknown.pages, null);
  assert.equal(unknown.estimate, null);
});

test("submitStage persists the estimate into pipeline-state.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "ppt-budget-"));
  const estimate = buildEstimate({ recommendations: { page_count: 45 }, budgetPages: 30 });
  const verdict = submitStage(dir, "stage2", { directions: [{ name: "a" }], page_count: 45 }, undefined, estimate);
  assert.equal(verdict.error, undefined);
  const saved = JSON.parse(readFileSync(join(dir, "laboflow", "pipeline-state.json"), "utf8"));
  assert.equal(saved.stages.stage2.estimate.pages, 45);
  assert.equal(saved.stages.stage2.estimate.budget.exceeds, true);
  // The panel reads it straight out of loadState.
  const state = loadState(dir).state;
  assert.equal(state.stages.stage2.estimate.estimate.tokensTotal, estimate.estimate.tokensTotal);
});
