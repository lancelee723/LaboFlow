/**
 * FR-PPT-16: generation cost estimate + configurable page budget.
 *
 * The estimate is a planning heuristic (the PRD asks for a pre-generation
 * forecast, not metered billing): an L2 page is hand-authored SVG against a
 * large corpus (~15k tokens in + out per page), an L1 page is one outline
 * normalization pass (~3k). The budget is page-based (settings.budgetPages);
 * exceeding it is allowed but must be explicit — the confirm card shows the
 * overrun and the user's confirmation itself is the waiver.
 */

const L2_TOKENS_PER_PAGE_IN = 15_000;
const L2_TOKENS_PER_PAGE_OUT = 8_000;
const L1_TOKENS_PER_PAGE_IN = 2_500;
const L1_TOKENS_PER_PAGE_OUT = 500;

/** Pull the page count out of whatever the agent submitted. */
export function pageCountFromRecommendations(recommendations) {
  if (!recommendations || typeof recommendations !== "object") return null;
  const candidates = [
    recommendations.page_count,
    recommendations.pageCount,
    Array.isArray(recommendations.pages) ? recommendations.pages.length : null,
    Array.isArray(recommendations.directions)
      ? recommendations.directions.find((d) => d && typeof d === "object" && (d.page_count ?? d.pageCount))
        ?.page_count ?? null
      : null,
    recommendations.roster && typeof recommendations.roster === "object"
      ? Object.keys(recommendations.roster).length
      : null,
  ];
  for (const value of candidates) {
    const page = Number(value);
    if (Number.isFinite(page) && page > 0 && page <= 200) return Math.round(page);
  }
  return null;
}

export function estimateCost({ pages, engine = "L2" }) {
  const page = Math.max(0, Math.round(Number(pages) || 0));
  const [tin, tout] =
    engine === "L1"
      ? [L1_TOKENS_PER_PAGE_IN, L1_TOKENS_PER_PAGE_OUT]
      : [L2_TOKENS_PER_PAGE_IN, L2_TOKENS_PER_PAGE_OUT];
  return {
    engine,
    pages: page,
    tokensIn: page * tin,
    tokensOut: page * tout,
    tokensTotal: page * (tin + tout),
  };
}

export function evaluateBudget({ pages, budgetPages }) {
  const page = Math.max(0, Math.round(Number(pages) || 0));
  const budget = Number(budgetPages);
  if (!Number.isFinite(budget) || budget <= 0) {
    return { budget: null, exceeds: false, ratio: null };
  }
  return {
    budget: Math.round(budget),
    exceeds: page > budget,
    ratio: Math.round((page / budget) * 100) / 100,
  };
}

/** One call for the submit path: estimate + budget verdict in i18n-neutral shape. */
export function buildEstimate({ recommendations, engine = "L2", budgetPages }) {
  const pages = pageCountFromRecommendations(recommendations);
  if (pages === null) return { pages: null, estimate: null, budget: evaluateBudget({ pages: 0, budgetPages: null }) };
  const estimate = estimateCost({ pages, engine });
  return { pages, estimate, budget: evaluateBudget({ pages, budgetPages }) };
}
