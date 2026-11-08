/**
 * FR-PPT-16: pre-generation cost estimate. Per-page cost is dominated by the
 * SVG authoring turn; the factor is calibrated against the 2026-10-02 real
 * run (3-page deck ≈ 180k total tokens) and deliberately generous so the
 * estimate errs high rather than surprising the user.
 */

export const TOKENS_PER_PAGE = 60_000;
export const BASE_OVERHEAD_TOKENS = 20_000;

export function estimateDeckTokens(pageCount) {
  const pages = Math.max(0, Number(pageCount) || 0);
  return BASE_OVERHEAD_TOKENS + pages * TOKENS_PER_PAGE;
}

/** Verdict for a stage-2 submission against the configured budget. */
export function budgetVerdict(pageCount, budgetTokens) {
  const estimate = estimateDeckTokens(pageCount);
  const budget = Number(budgetTokens) > 0 ? Number(budgetTokens) : null;
  if (budget === null || estimate <= budget) {
    return { ok: true, estimate, budget };
  }
  return { ok: false, estimate, budget, code: "PPT_BUDGET_EXCEEDED" };
}
