import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTokenCount } from "@pi-desktop/shared";
import type {
  OrgQuotaRemaining,
  OrgStatus,
  TokenUsageHistoryItem,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";

type RangeId = "7d" | "30d";

const HEAT_WEEKS = 26;
const TREND_MAX_DAYS = 30;
const TABLE_DAYS = 14;

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

export function TokenUsagePage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<TokenUsageHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<RangeId>("30d");
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
    api
      .getTokenUsageHistory({ bucket: "day" })
      .then((result) => {
        if (!cancelled) setItems(result.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
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

  // GitHub-style grid: HEAT_WEEKS columns of 7 days, Monday-first, ending this
  // week. Intensity uses quartiles of the nonzero daily totals.
  const heat = useMemo(() => {
    const cells: Array<{ key: string; total: number }> = [];
    const end = new Date();
    end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));
    for (let i = HEAT_WEEKS * 7 - 1; i >= 0; i -= 1) {
      const day = new Date(end);
      day.setDate(end.getDate() - i);
      const key = localDateKey(day);
      cells.push({ key, total: byDay.get(key)?.totalTokens ?? 0 });
    }
    const nonzero = cells.filter((cell) => cell.total > 0).map((cell) => cell.total);
    const quartile = (fraction: number) => {
      if (!nonzero.length) return 0;
      const sorted = [...nonzero].sort((a, b) => a - b);
      const value = sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
      return value || 0;
    };
    return {
      cells,
      levels: [quartile(0.33), quartile(0.66), quartile(0.9)],
      months: cells.reduce<Array<{ index: number; label: string }>>((labels, cell, index) => {
        const day = new Date(`${cell.key}T00:00:00`);
        if (day.getDate() <= 7) {
          const label = day.toLocaleDateString(undefined, { month: "short" });
          if (!labels.length || labels[labels.length - 1].label !== label) {
            labels.push({ index, label });
          }
        }
        return labels;
      }, []),
    };
  }, [byDay]);

  const trend = useMemo(() => {
    const days = range === "7d" ? 7 : TREND_MAX_DAYS;
    const now = new Date();
    const series: Array<{ key: string; input: number; output: number; total: number }> = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(now);
      day.setDate(now.getDate() - i);
      const key = localDateKey(day);
      const item = byDay.get(key);
      series.push({
        key,
        input: item?.inputTokens ?? 0,
        output: item?.outputTokens ?? 0,
        total: item?.totalTokens ?? 0,
      });
    }
    return series;
  }, [byDay, range]);

  const trendPath = (values: number[], width: number, height: number, max: number) => {
    const pad = 6;
    const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
    return values
      .map((value, index) => {
        const x = pad + index * step;
        const y = height - pad - (max ? (value / max) * (height - pad * 2) : 0);
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };

  const trendMax = Math.max(1, ...trend.map((point) => point.total));
  const trendArea = `${trendPath(trend.map((p) => p.total), 600, 180, trendMax)} L594,174 L6,174 Z`;

  const table = useMemo(() => trend.slice(-TABLE_DAYS).reverse(), [trend]);
  const hasData = stats.totalTokens > 0;

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
          <span className="usage-card-value">{stats.totalTurns}</span>
          <span className="usage-card-label">{t("settings.usage.totalTurns")}</span>
        </div>
      </div>

      <section className="usage-section">
        <h3 className="usage-section-title">{t("settings.usage.activity")}</h3>
        <div className="usage-heatmap" role="img" aria-label={t("settings.usage.activity")}>
          <div className="usage-heatmap-months">
            {heat.months.map((month) => (
              <span key={`${month.label}-${month.index}`} style={{ gridColumnStart: month.index + 1 }}>
                {month.label}
              </span>
            ))}
          </div>
          <div className="usage-heatmap-grid">
            {heat.cells.map((cell) => {
              const level = cell.total <= 0 ? 0 : cell.total <= heat.levels[0] ? 1 : cell.total <= heat.levels[1] ? 2 : 3;
              return (
                <div
                  key={cell.key}
                  className={`usage-heat-cell${level ? " is-active" : ""}`}
                  style={level ? { opacity: 0.25 + level * 0.25 } : undefined}
                  title={`${cell.key} · ${formatTokenCount(cell.total)}`}
                />
              );
            })}
          </div>
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
          <svg viewBox="0 0 600 180" preserveAspectRatio="xMidYMid meet">
            {[0.25, 0.5, 0.75].map((fraction) => (
              <line
                key={fraction}
                x1={6}
                x2={594}
                y1={6 + fraction * 168}
                y2={6 + fraction * 168}
                className="usage-chart-grid"
              />
            ))}
            {hasData ? (
              <>
                <path d={trendArea} className="usage-chart-area" />
                <polyline
                  points={trend
                    .map((point, index) => {
                      const x = 6 + (index * 588) / Math.max(1, trend.length - 1);
                      const y = 174 - (point.total / trendMax) * 168;
                      return `${x.toFixed(1)},${y.toFixed(1)}`;
                    })
                    .join(" ")}
                  className="usage-chart-line"
                />
                <polyline
                  points={trend
                    .map((point, index) => {
                      const x = 6 + (index * 588) / Math.max(1, trend.length - 1);
                      const y = 174 - ((point.input / trendMax) * 168 || 0);
                      return `${x.toFixed(1)},${y.toFixed(1)}`;
                    })
                    .join(" ")}
                  className="usage-chart-line is-input"
                />
              </>
            ) : null}
          </svg>
          <div className="usage-chart-legend">
            <span className="is-total">{t("settings.usage.totalTokens")}</span>
            <span className="is-input">{t("settings.usage.inputTokens")}</span>
            <span>
              {trend.length
                ? `${trend[0].key} ~ ${trend[trend.length - 1].key}`
                : ""}
            </span>
          </div>
        </div>
      </section>

      <section className="usage-section">
        <h3 className="usage-section-title">{t("settings.usage.dailyBreakdown")}</h3>
        <table className="usage-table">
          <thead>
            <tr>
              <th>{t("settings.usage.columnDate")}</th>
              <th>{t("settings.usage.inputTokens")}</th>
              <th>{t("settings.usage.outputTokens")}</th>
              <th>{t("settings.usage.cacheTokens")}</th>
              <th>{t("settings.usage.totalTokens")}</th>
              <th>{t("settings.usage.turns")}</th>
            </tr>
          </thead>
          <tbody>
            {table.map((row) => {
              const item = byDay.get(row.key);
              return (
                <tr key={row.key}>
                  <td>{row.key}</td>
                  <td>{formatTokenCount(item?.inputTokens ?? 0)}</td>
                  <td>{formatTokenCount(item?.outputTokens ?? 0)}</td>
                  <td>
                    {formatTokenCount(
                      (item?.cacheReadTokens ?? 0) + (item?.cacheWriteTokens ?? 0),
                    )}
                  </td>
                  <td>{formatTokenCount(item?.totalTokens ?? 0)}</td>
                  <td>{item?.turnCount ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
