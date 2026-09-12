import type {
  TokenInsightsFactsResult,
  TokenUsageHistoryItem,
  TokenUsageModelSeries,
} from "@pi-desktop/shared";

/**
 * Bridge between the Token Insights plugin's published fact cube and the
 * usage stats page's rendering shapes. The plugin (pi.token-insights) already
 * aggregates usage live across sources — transcript metadata folded with the
 * host's completed turns — so the page renders that aggregation instead of
 * maintaining its own metering. This module only re-buckets the cube's
 * (day, hour, source, model, provider, session) rows into per-day totals and
 * per-model daily series; it never reads transcripts itself.
 */

export type FactsUsage = {
  items: TokenUsageHistoryItem[];
  models: TokenUsageModelSeries[];
};

/** The cube's source-column id for this app's own usage. */
export const TOKEN_INSIGHTS_APP_SOURCE = "pi-desktop";

function emptyItem(date: string): TokenUsageHistoryItem {
  return {
    date,
    timestamp: Date.parse(`${date}T00:00:00`) || 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    turnCount: 0,
  };
}

/**
 * Fold the fact cube into per-day items plus per-model daily series, both
 * sorted by date and models ranked by total consumption (heaviest first, the
 * order the trend legend leads with). When `sourceId` is given, only rows
 * from that tool source are counted — the usage stats page scopes to this
 * app's own usage ("pi-desktop") while the plugin panel keeps the cross-tool
 * view. Returns null when the cube is absent, malformed, or carries no rows
 * for the filter — the page then falls back to host history.
 */
export function usageFromTokenInsightsFacts(
  facts: TokenInsightsFactsResult | null | undefined,
  options?: { sourceId?: string },
): FactsUsage | null {
  const columns = facts?.columns;
  const buckets = facts?.buckets;
  if (!facts?.available || !columns || !buckets?.length) return null;

  const column = (name: string) => columns.indexOf(name);
  const dayIndex = column("day");
  const modelIndex = column("model");
  const sourceIndex = options?.sourceId ? column("source") : -1;
  const inputIndex = column("input");
  const outputIndex = column("output");
  const cacheReadIndex = column("cacheRead");
  const cacheWriteIndex = column("cacheWrite");
  const reasoningIndex = column("reasoning");
  const totalIndex = column("total");
  if (dayIndex < 0 || inputIndex < 0 || outputIndex < 0 || totalIndex < 0) {
    return null;
  }
  const days = facts.days ?? [];
  const models = facts.models ?? [];
  // Token Insights ships sources as {id, label} objects; bare strings are
  // accepted for forward compatibility.
  const sourceAt = (index: number) => {
    const entry = facts.sources?.[index];
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object" && typeof entry.id === "string") {
      return entry.id;
    }
    return "";
  };
  const dayAt = (index: number) => days[index] ?? "";
  const modelAt = (index: number) => models[index] ?? "unknown";

  const byDay = new Map<string, TokenUsageHistoryItem>();
  const byModelDay = new Map<string, Map<string, TokenUsageHistoryItem>>();
  const modelTotals = new Map<string, number>();

  for (const row of buckets) {
    if (!Array.isArray(row)) continue;
    const date = dayAt(row[dayIndex]);
    if (!date) continue;
    // Optional tool-source scope: the usage stats page counts only this
    // app's own rows ("pi-desktop"), never other tools on the machine.
    if (sourceIndex >= 0 && sourceAt(row[sourceIndex]) !== options?.sourceId) {
      continue;
    }
    const modelId = modelIndex >= 0 ? modelAt(row[modelIndex]) : "unknown";

    let dayItem = byDay.get(date);
    if (!dayItem) {
      dayItem = emptyItem(date);
      byDay.set(date, dayItem);
    }
    let modelDays = byModelDay.get(modelId);
    if (!modelDays) {
      modelDays = new Map();
      byModelDay.set(modelId, modelDays);
    }
    let modelItem = modelDays.get(date);
    if (!modelItem) {
      modelItem = emptyItem(date);
      modelDays.set(date, modelItem);
    }

    const input = Number(row[inputIndex]) || 0;
    const output = Number(row[outputIndex]) || 0;
    const cacheRead = cacheReadIndex >= 0 ? Number(row[cacheReadIndex]) || 0 : 0;
    const cacheWrite = cacheWriteIndex >= 0 ? Number(row[cacheWriteIndex]) || 0 : 0;
    const reasoning = reasoningIndex >= 0 ? Number(row[reasoningIndex]) || 0 : 0;
    // The cube's own total (input+output+cache+reasoning); fall back to the
    // sum when a producer omitted the column.
    const total =
      totalIndex >= 0 ? Number(row[totalIndex]) || 0 : input + output + cacheRead + cacheWrite + reasoning;

    dayItem.inputTokens += input;
    dayItem.outputTokens += output;
    dayItem.cacheReadTokens += cacheRead;
    dayItem.cacheWriteTokens += cacheWrite;
    dayItem.reasoningTokens += reasoning;
    dayItem.totalTokens += total;
    modelItem.inputTokens += input;
    modelItem.outputTokens += output;
    modelItem.cacheReadTokens += cacheRead;
    modelItem.cacheWriteTokens += cacheWrite;
    modelItem.reasoningTokens += reasoning;
    modelItem.totalTokens += total;
    modelTotals.set(modelId, (modelTotals.get(modelId) ?? 0) + total);
  }

  if (!byDay.size) return null;
  const byDate = (left: TokenUsageHistoryItem, right: TokenUsageHistoryItem) =>
    left.date.localeCompare(right.date);
  const series: TokenUsageModelSeries[] = [...byModelDay.entries()]
    .map(([modelId, days]) => ({
      modelId,
      items: [...days.values()].sort(byDate),
    }))
    .sort(
      (left, right) =>
        (modelTotals.get(right.modelId) ?? 0) - (modelTotals.get(left.modelId) ?? 0) ||
        left.modelId.localeCompare(right.modelId),
    );
  return {
    items: [...byDay.values()].sort(byDate),
    models: series,
  };
}
