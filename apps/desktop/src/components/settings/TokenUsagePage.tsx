import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTokenCount } from "@pi-desktop/shared";
import type {
  OrgQuotaRemaining,
  OrgStatus,
  TokenUsageHistoryItem,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import {
  TOKEN_INSIGHTS_APP_SOURCE,
  usageFromTokenInsightsFacts,
} from "../../lib/token-insights";

type RangeId = "7d" | "30d";
/** ZCode-parity granularity for the activity heatmap. */
type HeatMode = "day" | "week" | "cumulative";

const HEAT_WEEKS = 26;
const TREND_MAX_DAYS = 30;
/** Categorical palette for per-model trend lines (ZCode reference order). */
const MODEL_COLORS = [
  "#3d7eff",
  "#2fb344",
  "#f59e0b",
  "#a855f7",
  "#ef4444",
  "#14b8a6",
  "#f97316",
  "#6366f1",
  "#ec4899",
  "#64748b",
];

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function computeStreaks(activeKeys: Set<string>): { current: number; longest: number } {
  const today = new Date();
  let current = 0;
  for (let offset = 0; offset < 366; offset += 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    if (activeKeys.has(localDateKey(day))) current += 1;
    else break;
  }
  const sorted = [...activeKeys].sort();
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const key of sorted) {
    const time = Date.parse(`${key}T00:00:00`);
    if (previous !== null && time - previous === 86_400_000) run += 1;
    else run = 1;
    previous = time;
    longest = Math.max(longest, run);
  }
  return { current, longest };
}

/**
 * Monotone cubic (Fritsch–Carlson) spline through the points, emitted as
 * cubic Béziers. Rounded like the ZCode reference, but unlike Catmull-Rom it
 * never overshoots a local extremum, so a spiky token day (one huge day
 * between quiet ones) cannot push the curve outside the chart frame.
 */
function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (!points.length) return "";
  if (points.length < 3) {
    return points
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(" ");
  }
  const n = points.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = points[i + 1].x - points[i].x;
    slope[i] = dx[i] === 0 ? 0 : (points[i + 1].y - points[i].y) / dx[i];
  }
  const tangent: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) {
      // Local extremum: a flat tangent is what keeps the curve from
      // overshooting the neighboring points.
      tangent[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangent[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  tangent[n - 1] = slope[n - 2];
  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const h = dx[i];
    const c1x = p1.x + h / 3;
    const c1y = p1.y + (tangent[i] * h) / 3;
    const c2x = p2.x - h / 3;
    const c2y = p2.y - (tangent[i + 1] * h) / 3;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

/** Trend chart geometry: viewBox and the drawing area inside its padding. */
const CHART_WIDTH = 600;
const CHART_HEIGHT = 200;
const CHART_PAD = 12;
/** Vertical band under the plot area reserved for date ticks. */
const CHART_LABEL_BAND = 26;
/** Plot-area bottom (date ticks render below it). */
const CHART_PLOT_BOTTOM = CHART_HEIGHT - CHART_PAD - CHART_LABEL_BAND;

type HeatCell = {
  key: string;
  label: string;
  /** Extra detail line for the hover card (cumulative total, week span…). */
  detail?: string;
  total: number;
};

export function TokenUsagePage() {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<TokenUsageHistoryItem[]>([]);
  const [modelSeries, setModelSeries] = useState<
    Array<{ modelId: string; items: TokenUsageHistoryItem[] }>
  >([]);
  // The page renders the Token Insights plugin's live aggregation; host turn
  // history is only the fallback when the plugin is absent. `hostTurnCount`
  // keeps the turns card on the host's definition (agent turns, not plugin
  // message rows) regardless of which source fed the charts.
  const [dataSource, setDataSource] = useState<"plugin" | "host">("host");
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [hostTurnCount, setHostTurnCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<RangeId>("30d");
  const [heatMode, setHeatMode] = useState<HeatMode>("day");
  const [hover, setHover] = useState<{ cell: HeatCell; x: number; y: number } | null>(
    null,
  );
  const heatRef = useRef<HTMLDivElement | null>(null);
  const [orgStatus, setOrgStatus] = useState<OrgStatus | null>(null);
  const [quota, setQuota] = useState<OrgQuotaRemaining | null>(null);

  useEffect(() => {
    let cancelled = false;
    // P3 quota panel: when the org session is live, surface limits × usage.
    api
      .orgStatus()
      .then((status) => {
        if (cancelled) return;
        setOrgStatus(status);
        if (status.state === "connected") {
          api
            .orgQuotaRemaining()
            .then((remaining) => {
              if (!cancelled) setQuota(remaining);
            })
            .catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Primary: the Token Insights plugin's live fact cube (its own scan covers
    // transcripts and the host's completed turns). Fallback: host history.
    Promise.allSettled([
      api.getTokenInsights(),
      api.getTokenUsageHistory({ bucket: "day" }),
    ]).then(([factsResult, historyResult]) => {
      if (cancelled) return;
      const hostItems =
        historyResult.status === "fulfilled" ? historyResult.value.items ?? [] : [];
      const hostModels =
        historyResult.status === "fulfilled" ? historyResult.value.models ?? [] : [];
      const hostTurns =
        historyResult.status === "fulfilled"
          ? historyResult.value.totals?.turnCount ?? 0
          : 0;
      const facts = factsResult.status === "fulfilled" ? factsResult.value : null;
      // Scope to this app's own usage: the plugin cube also folds in other
      // tools on the machine (Claude Code, Codex…), which belong to its own
      // cross-tool panel, not to LaboFlow's stats page.
      const fromFacts = usageFromTokenInsightsFacts(facts, {
        sourceId: TOKEN_INSIGHTS_APP_SOURCE,
      });
      if (fromFacts) {
        setItems(fromFacts.items);
        setModelSeries(fromFacts.models);
        setDataSource("plugin");
        setGeneratedAt(facts?.generatedAt ?? null);
      } else {
        setItems(hostItems);
        setModelSeries(hostModels);
        setDataSource("host");
        setGeneratedAt(null);
      }
      setHostTurnCount(hostTurns);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const byDay = useMemo(() => {
    const map = new Map<string, TokenUsageHistoryItem>();
    for (const item of items) map.set(item.date.slice(0, 10), item);
    return map;
  }, [items]);

  const stats = useMemo(() => {
    let totalTokens = 0;
    let totalTurns = 0;
    let peak = 0;
    const activeKeys = new Set<string>();
    for (const item of items) {
      totalTokens += item.totalTokens;
      totalTurns += item.turnCount;
      peak = Math.max(peak, item.totalTokens);
      if (item.totalTokens > 0) activeKeys.add(item.date.slice(0, 10));
    }
    const streaks = computeStreaks(activeKeys);
    return {
      totalTokens,
      totalTurns,
      peak,
      currentStreak: streaks.current,
      longestStreak: streaks.longest,
    };
  }, [items]);

  // GitHub-style day grid: HEAT_WEEKS columns of 7 days, Monday-first, ending
  // this week. Intensity uses quartiles of the nonzero daily totals.
  const dayHeat = useMemo(() => {
    const cells: HeatCell[] = [];
    const end = new Date();
    end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));
    for (let i = HEAT_WEEKS * 7 - 1; i >= 0; i -= 1) {
      const day = new Date(end);
      day.setDate(end.getDate() - i);
      const key = localDateKey(day);
      cells.push({
        key,
        label: key,
        total: byDay.get(key)?.totalTokens ?? 0,
      });
    }
    // Month axis: one label per calendar month spanning exactly the grid
    // columns that month occupies (GitHub-style). `index` counts CELLS (days,
    // column-flow: 7 per column), so the column is index/7 — feeding the raw
    // day index to gridColumn pushed every label past the month it belongs to.
    const months: Array<{ label: string; start: number; end: number }> = [];
    cells.forEach((cell, index) => {
      const column = Math.floor(index / 7);
      const label = new Date(`${cell.key}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
      });
      const last = months[months.length - 1];
      if (last && last.label === label) last.end = column;
      else months.push({ label, start: column, end: column });
    });
    return { cells, months };
  }, [byDay]);

  // All three granularities share ONE canvas: the same 7×26 day grid and the
  // same month axis as the daily view. Weekly/cumulative only change the
  // tinting granularity — every cell is colored by its week's / month's bucket
  // total (ZCode-style unified visual), and the hover card names the bucket.
  const heat = useMemo(() => {
    const weekKeyOf = (key: string) => {
      const day = new Date(`${key}T00:00:00`);
      day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
      return localDateKey(day);
    };
    const weekTotals = new Map<string, number>();
    const monthTotals = new Map<string, number>();
    for (const [key, item] of byDay) {
      const weekKey = weekKeyOf(key);
      const monthKey = key.slice(0, 7);
      weekTotals.set(weekKey, (weekTotals.get(weekKey) ?? 0) + item.totalTokens);
      monthTotals.set(monthKey, (monthTotals.get(monthKey) ?? 0) + item.totalTokens);
    }
    const cells = dayHeat.cells.map((cell) => {
      if (heatMode === "day") return cell;
      const total =
        heatMode === "week"
          ? (weekTotals.get(weekKeyOf(cell.key)) ?? 0)
          : (monthTotals.get(cell.key.slice(0, 7)) ?? 0);
      const bucketLabel = t(
        heatMode === "week" ? "settings.usage.weekTotal" : "settings.usage.monthTotal",
      );
      return {
        ...cell,
        total,
        detail: `${bucketLabel}: ${formatTokenCount(total)}`,
      };
    });
    const nonzero = cells.filter((cell) => cell.total > 0).map((cell) => cell.total);
    const quartile = (fraction: number) => {
      if (!nonzero.length) return 0;
      const sorted = [...nonzero].sort((a, b) => a - b);
      const value =
        sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
      return value || 0;
    };
    return {
      cells,
      levels: [quartile(0.33), quartile(0.66), quartile(0.9)],
      months: dayHeat.months,
    };
  }, [heatMode, dayHeat, byDay, t]);

  const showHeatCell = (cell: HeatCell, event: React.MouseEvent<HTMLDivElement>) => {
    const host = heatRef.current?.getBoundingClientRect();
    if (!host) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setHover({
      cell,
      x: rect.left - host.left + rect.width / 2,
      y: rect.top - host.top,
    });
  };

  // The API returns flat arrays; index each model's items by date once.
  const modelByDay = useMemo(() => {
    return modelSeries.map((model) => {
      const map = new Map<string, TokenUsageHistoryItem>();
      for (const item of model.items) map.set(item.date.slice(0, 10), item);
      return { modelId: model.modelId, byDay: map };
    });
  }, [modelSeries]);

  const trendSeries = useMemo(() => {
    const days = range === "7d" ? 7 : TREND_MAX_DAYS;
    const now = new Date();
    const keys: string[] = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(now);
      day.setDate(now.getDate() - i);
      keys.push(localDateKey(day));
    }
    const active = modelSeries
      .map((model) => ({
        modelId: model.modelId,
        items: model.items,
      }))
      .filter((model) => model.items.some((item) => item.totalTokens > 0))
      .slice(0, MODEL_COLORS.length);
    const series = active.map((model, index) => {
      const byDayMap = modelByDay.find((entry) => entry.modelId === model.modelId)?.byDay;
      return {
        modelId: model.modelId,
        color: MODEL_COLORS[index % MODEL_COLORS.length],
        values: keys.map((key) => byDayMap?.get(key)?.totalTokens ?? 0),
      };
    });
    // Older hosts without per-model data still draw one rounded total line.
    if (!series.length) {
      series.push({
        modelId: "total",
        color: MODEL_COLORS[0],
        values: keys.map((key) => byDay.get(key)?.totalTokens ?? 0),
      });
    }
    return { keys, series };
  }, [range, modelSeries, modelByDay, byDay]);

  const trendMax = Math.max(
    1,
    ...trendSeries.series.flatMap((series) => series.values),
  );

  const trendX = (index: number) =>
    CHART_PAD +
    (index * (CHART_WIDTH - CHART_PAD * 2)) /
      Math.max(1, trendSeries.keys.length - 1);
  const trendY = (value: number) =>
    CHART_PLOT_BOTTOM -
    (trendMax ? (value / trendMax) * (CHART_PLOT_BOTTOM - CHART_PAD) : 0);

  const trendLinePath = (values: number[]) => {
    const points = values.map((value, index) => ({
      x: trendX(index),
      y: trendY(value),
    }));
    return smoothPath(points);
  };

  // Day tick labels: about one per eighth of the window so 30d stays legible,
  // always ending on today, localized by the app language (9月12日 / Sep 12).
  const dayLabelFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language || undefined, {
        month: "short",
        day: "numeric",
      }),
    [i18n.resolvedLanguage, i18n.language],
  );
  const formatDateKey = (key: string) => {
    const date = new Date(`${key}T00:00:00`);
    return Number.isNaN(date.getTime()) ? key : dayLabelFormatter.format(date);
  };
  const trendTicks = useMemo(() => {
    const count = trendSeries.keys.length;
    if (!count) return [] as number[];
    const step = Math.max(1, Math.ceil(count / 8));
    const ticks: number[] = [];
    for (let i = 0; i < count; i += step) ticks.push(i);
    if (ticks[ticks.length - 1] !== count - 1) ticks.push(count - 1);
    if (
      ticks.length > 2 &&
      ticks[ticks.length - 1] - ticks[ticks.length - 2] < step * 0.6
    ) {
      ticks.splice(ticks.length - 2, 1);
    }
    return ticks;
  }, [trendSeries.keys]);

  // Hovered day on the trend chart: nearest data point to the pointer.
  const [trendHover, setTrendHover] = useState<number | null>(null);
  const onTrendMouseMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !trendSeries.keys.length) return;
    const vx = ((event.clientX - rect.left) / rect.width) * CHART_WIDTH;
    const step = (CHART_WIDTH - CHART_PAD * 2) / Math.max(1, trendSeries.keys.length - 1);
    const next = Math.max(
      0,
      Math.min(trendSeries.keys.length - 1, Math.round((vx - CHART_PAD) / step)),
    );
    if (next !== trendHover) setTrendHover(next);
  };

  // Cumulative per-model consumption for the donut, colored by the same
  // ranking the trend legend uses so the two charts read as one story.
  const modelTotals = useMemo(() => {
    return modelSeries
      .map((model) => ({
        modelId: model.modelId,
        total: model.items.reduce((sum, item) => sum + item.totalTokens, 0),
      }))
      .filter((model) => model.total > 0)
      .slice(0, MODEL_COLORS.length)
      .map((model, index) => ({
        ...model,
        color: MODEL_COLORS[index % MODEL_COLORS.length],
      }));
  }, [modelSeries]);
  const modelTotalsSum = modelTotals.reduce((sum, model) => sum + model.total, 0);
  const donutSegments = useMemo(() => {
    let offset = 25; // dashoffset that starts the first arc at 12 o'clock
    const gap = modelTotals.length > 1 ? 0.6 : 0;
    return modelTotals.map((model) => {
      const share = modelTotalsSum ? (model.total / modelTotalsSum) * 100 : 0;
      const segment = { ...model, share, dash: Math.max(0, share - gap), offset };
      offset -= share;
      return segment;
    });
  }, [modelTotals, modelTotalsSum]);

  const hasData = stats.totalTokens > 0;
  // "Turns" is a host-side concept (one agent round); the plugin cube counts
  // message rows instead, so the card keeps the host's number either way.
  const totalTurns =
    dataSource === "plugin" && hostTurnCount !== null
      ? hostTurnCount
      : stats.totalTurns;

  if (loading) {
    return <div className="usage-page usage-loading">{t("settings.loadingCapabilities")}</div>;
  }

  return (
    <div className="usage-page">
      {!hasData ? <div className="usage-empty">{t("settings.usage.empty")}</div> : null}

      {orgStatus?.state === "connected" ? (
        <section className="usage-section">
          <h3 className="usage-section-title">{t("settings.usage.orgQuota")}</h3>
          <div className="usage-quota-card">
            {quota?.entries?.length ? (
              quota.entries.map((entry, index) => {
                const limit = Math.max(1, entry.limit);
                const teamRatio = entry.teamUsed != null ? entry.teamUsed / limit : null;
                const selfRatio = entry.selfUsed / limit;
                const worst = Math.max(teamRatio ?? 0, selfRatio);
                const tone = worst >= 1 ? "error" : worst >= 0.8 ? "warning" : "ok";
                return (
                  <div className={`usage-quota-row is-${tone}`} key={`${entry.kind}-${entry.period}-${index}`}>
                    <div className="usage-quota-head">
                      <span className="usage-quota-kind">
                        {t(entry.kind === "tokens" ? "settings.usage.tokensKind" : "settings.usage.sessionsKind")}
                        <span className="usage-quota-period">
                          {t(
                            entry.period === "daily"
                              ? "settings.usage.periodDay"
                              : entry.period === "weekly"
                                ? "settings.usage.periodWeek"
                                : "settings.usage.periodMonth",
                          )}
                        </span>
                      </span>
                      <span className="usage-quota-flags">
                        {teamRatio != null ? (
                          <span>
                            {t("settings.usage.team")}: {entry.teamUsed}/{entry.limit}
                          </span>
                        ) : null}
                        <span>
                          {t("settings.usage.self")}: {entry.selfUsed}/{entry.limit}
                        </span>
                        {worst >= 1 ? (
                          <b className="usage-quota-exceeded">{t("settings.usage.exceeded")}</b>
                        ) : null}
                      </span>
                    </div>
                    <div className="usage-quota-bar">
                      <div
                        className="usage-quota-fill"
                        style={{ width: `${Math.min(100, worst * 100).toFixed(1)}%` }}
                      />
                    </div>
                    {entry.resetAt ? (
                      <div className="usage-quota-reset">
                        {t("settings.usage.reset", {
                          time: new Date(entry.resetAt).toLocaleString(),
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <div className="usage-quota-none">{t("settings.usage.quotaNone")}</div>
            )}
          </div>
        </section>
      ) : null}

      <div className="usage-cards">
        <div className="usage-card">
          <span className="usage-card-value">{formatTokenCount(stats.totalTokens)}</span>
          <span className="usage-card-label">{t("settings.usage.totalTokens")}</span>
        </div>
        <div className="usage-card">
          <span className="usage-card-value">{formatTokenCount(stats.peak)}</span>
          <span className="usage-card-label">{t("settings.usage.peakTokens")}</span>
        </div>
        <div className="usage-card">
          <span className="usage-card-value">{stats.currentStreak}</span>
          <span className="usage-card-label">{t("settings.usage.currentStreak")}</span>
        </div>
        <div className="usage-card">
          <span className="usage-card-value">{stats.longestStreak}</span>
          <span className="usage-card-label">{t("settings.usage.longestStreak")}</span>
        </div>
        <div className="usage-card">
          <span className="usage-card-value">{totalTurns}</span>
          <span className="usage-card-label">{t("settings.usage.totalTurns")}</span>
        </div>
      </div>

      <section className="usage-section">
        <div className="usage-section-head">
          <h3 className="usage-section-title">{t("settings.usage.activity")}</h3>
          {dataSource === "plugin" && generatedAt ? (
            <span className="usage-data-note">
              {t("settings.usage.dataUpdated", {
                time: new Date(generatedAt).toLocaleString(),
              })}
            </span>
          ) : null}
          <div className="usage-range" role="tablist">
            {(["day", "week", "cumulative"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={heatMode === mode}
                className={heatMode === mode ? "is-active" : ""}
                onClick={() => {
                  setHeatMode(mode);
                  setHover(null);
                }}
              >
                {t(
                  mode === "day"
                    ? "settings.usage.heatDay"
                    : mode === "week"
                      ? "settings.usage.heatWeek"
                      : "settings.usage.heatCumulative",
                )}
              </button>
            ))}
          </div>
        </div>
        <div
          className="usage-heatmap"
          ref={heatRef}
          role="img"
          aria-label={t("settings.usage.activity")}
          onMouseLeave={() => setHover(null)}
        >
          <div className="usage-heatmap-months">
            {/* A one-column month would clip its label; GitHub hides those.
                gridRow pins every label to the first row: adjacent months
                share one grid column at mixed-week boundaries, and without
                the explicit row auto-placement wraps the overlapping span
                onto a new line (staircase layout, tall empty band). */}
            {heat.months
              .filter((month) => month.end > month.start)
              .map((month) => (
                <span
                  key={`${month.label}-${month.start}`}
                  style={{
                    gridColumn: `${month.start + 1} / ${month.end + 2}`,
                    gridRow: "1",
                  }}
                >
                  {month.label}
                </span>
              ))}
          </div>
          <div className="usage-heatmap-grid">
            {heat.cells.map((cell) => {
              const level =
                cell.total <= 0 ? 0 : cell.total <= heat.levels[0] ? 1 : cell.total <= heat.levels[1] ? 2 : 3;
              const hovered = hover?.cell.key === cell.key;
              return (
                <div
                  key={cell.key}
                  className={`usage-heat-cell${level ? " is-active" : ""}${hovered ? " is-hover" : ""}`}
                  style={level ? { opacity: 0.25 + level * 0.25 } : undefined}
                  onMouseEnter={(event) => showHeatCell(cell, event)}
                />
              );
            })}
          </div>
          {hover ? (
            <div
              className="usage-heat-tooltip"
              style={{ left: hover.x, top: hover.y }}
              role="status"
            >
              <div className="usage-heat-tooltip-label">{hover.cell.label}</div>
              <div className="usage-heat-tooltip-value">
                {formatTokenCount(hover.cell.total)}
              </div>
              {hover.cell.detail ? (
                <div className="usage-heat-tooltip-detail">{hover.cell.detail}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="usage-section">
        <div className="usage-section-head">
          <h3 className="usage-section-title">{t("settings.usage.trend")}</h3>
          <div className="usage-range" role="tablist">
            {(["7d", "30d"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="tab"
                aria-selected={range === candidate}
                className={range === candidate ? "is-active" : ""}
                onClick={() => setRange(candidate)}
              >
                {t(candidate === "7d" ? "settings.usage.range7" : "settings.usage.range30")}
              </button>
            ))}
          </div>
        </div>
        <div className="usage-chart">
          <svg
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="xMidYMid meet"
            onMouseMove={(event) => onTrendMouseMove(event)}
            onMouseLeave={() => setTrendHover(null)}
          >
            {[0.25, 0.5, 0.75].map((fraction) => (
              <line
                key={fraction}
                x1={CHART_PAD}
                x2={CHART_WIDTH - CHART_PAD}
                y1={CHART_PAD + fraction * (CHART_PLOT_BOTTOM - CHART_PAD)}
                y2={CHART_PAD + fraction * (CHART_PLOT_BOTTOM - CHART_PAD)}
                className="usage-chart-grid"
              />
            ))}
            {hasData
              ? trendSeries.series.map((series) => (
                  <path
                    key={series.modelId}
                    d={trendLinePath(series.values)}
                    className="usage-chart-line"
                    // Inline style, not the `stroke` attribute: CSS class rules
                    // beat presentation attributes and would paint every model's
                    // line with the same text color.
                    style={{ stroke: series.color }}
                  />
                ))
              : null}
            {trendHover !== null && hasData ? (
              <g>
                <line
                  x1={trendX(trendHover)}
                  x2={trendX(trendHover)}
                  y1={CHART_PAD}
                  y2={CHART_PLOT_BOTTOM}
                  className="usage-chart-hover-line"
                />
                {trendSeries.series.map((series) => (
                  <circle
                    key={`dot-${series.modelId}`}
                    cx={trendX(trendHover)}
                    cy={trendY(series.values[trendHover] ?? 0)}
                    r={3.5}
                    className="usage-chart-hover-dot"
                    style={{
                      fill: series.color,
                      stroke: "var(--ds-bg-elevated-opaque)",
                    }}
                  />
                ))}
              </g>
            ) : null}
            {trendTicks.map((tick) => (
              <text
                key={`tick-${tick}`}
                x={trendX(tick)}
                y={CHART_HEIGHT - 7}
                textAnchor={
                  tick === 0
                    ? "start"
                    : tick === trendSeries.keys.length - 1
                      ? "end"
                      : "middle"
                }
                className="usage-tick"
                // Sized in viewBox units so the rendered text matches the
                // HTML legend below (CSS px tokens would scale with the svg).
                fontSize={9}
              >
                {formatDateKey(trendSeries.keys[tick])}
              </text>
            ))}
          </svg>
          {trendHover !== null && hasData ? (
            <div
              className="usage-trend-tooltip"
              role="status"
              style={{
                left: `${Math.min(85, Math.max(15, (trendX(trendHover) / CHART_WIDTH) * 100))}%`,
                top: `${
                  (Math.min(
                    ...trendSeries.series.map(
                      (series) => trendY(series.values[trendHover] ?? 0),
                    ),
                  ) /
                    CHART_HEIGHT) *
                  100 -
                  6
                }%`,
              }}
            >
              <div className="usage-trend-tooltip-title">
                {formatDateKey(trendSeries.keys[trendHover])} ·{" "}
                {formatTokenCount(
                  trendSeries.series.reduce(
                    (sum, series) => sum + (series.values[trendHover] ?? 0),
                    0,
                  ),
                )}{" "}
                tokens
              </div>
              {trendSeries.series.map((series) => (
                <div className="usage-trend-tooltip-row" key={series.modelId}>
                  <span
                    className="usage-chart-legend-dot"
                    style={{ background: series.color }}
                    aria-hidden
                  />
                  <span className="usage-trend-tooltip-model">{series.modelId}</span>
                  <span className="usage-trend-tooltip-value">
                    {formatTokenCount(series.values[trendHover] ?? 0)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="usage-chart-legend">
            {trendSeries.series.map((series) => (
              <span key={series.modelId} className="usage-chart-legend-model">
                <span
                  className="usage-chart-legend-dot"
                  style={{ background: series.color }}
                  aria-hidden
                />
                {series.modelId === "total"
                  ? t("settings.usage.totalTokens")
                  : series.modelId === "unknown"
                    ? t("settings.usage.unknownModel")
                    : series.modelId}
              </span>
            ))}
          </div>
        </div>
      </section>

      {donutSegments.length > 0 ? (
        <section className="usage-section">
          <h3 className="usage-section-title">{t("settings.usage.modelUsage")}</h3>
          <div className="usage-donut">
            <div className="usage-donut-left">
              <svg
                viewBox="0 0 42 42"
                className="usage-donut-svg"
                role="img"
                aria-label={t("settings.usage.modelUsage")}
              >
                {donutSegments.map((segment) => (
                  <circle
                    key={segment.modelId}
                    cx="21"
                    cy="21"
                    r="15.9155"
                    fill="none"
                    stroke={segment.color}
                    strokeWidth="5.5"
                    strokeDasharray={`${segment.dash} ${100 - segment.dash}`}
                    strokeDashoffset={segment.offset}
                    className="usage-donut-seg"
                  />
                ))}
              <text x="21" y="20.5" className="usage-donut-total" fontSize={3}>
                {formatTokenCount(modelTotalsSum)}
              </text>
              <text x="21" y="24" className="usage-donut-unit" fontSize={1.5}>
                tokens
              </text>
              </svg>
            </div>
            <div className="usage-donut-legend">
              {donutSegments.map((segment) => (
                <div className="usage-donut-row" key={segment.modelId}>
                  <div className="usage-donut-row-head">
                    <span
                      className="usage-chart-legend-dot"
                      style={{ background: segment.color }}
                      aria-hidden
                    />
                    <span className="usage-donut-model">{segment.modelId}</span>
                    <span className="usage-donut-pct">
                      {segment.share >= 0.1
                        ? `${Math.round(segment.share)}%`
                        : `${segment.share.toFixed(1)}%`}
                    </span>
                  </div>
                  <div className="usage-donut-tokens">
                    {formatTokenCount(segment.total)} tokens
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
