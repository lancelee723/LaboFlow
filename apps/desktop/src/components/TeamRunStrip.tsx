import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExpertTeamProgress } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { IconGraduationCap, IconUsers } from "./icons";

/**
 * Live expert-team progress strip for one session (module 01 refinement).
 * Rendered from the existing expertTeamRun event stream while a team run
 * dispatched from this session is in flight — member chips with status, the
 * active pipeline stage with its round counter, and the token budget bar
 * (Workbuddy-style in-conversation execution visibility). The settled result
 * is the persisted team-card message; the strip removes itself once the run
 * reaches done/failed.
 */

interface TeamRunStage {
  index: number;
  total: number;
  name: string;
  round?: number;
  maxRounds?: number;
  expert?: string;
}

interface TeamRunView {
  runId: string;
  teamName: string;
  phase: string;
  members: Array<{ expert: string; status: string }>;
  totalTokens: number;
  budgetTokens?: number;
  stage?: TeamRunStage;
  updatedAt: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function memberStatusGlyph(status: string): string {
  if (status === "done" || status === "completed") return "✓";
  if (status === "failed" || status === "error") return "×";
  if (status === "running") return "●";
  return "○";
}

export function TeamRunStrip({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [run, setRun] = useState<TeamRunView | null>(null);

  // Same reducer shape as the expert center's runs list, narrowed to this
  // session and to the newest run seen here.
  useEffect(() => {
    const off = api.onExpertTeamRun((event: ExpertTeamProgress) => {
      if (event.sessionId !== sessionId) return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (!asString(payload.team)) return;
      setRun((prev) => {
        if (prev && prev.runId !== event.runId && prev.phase !== "done" && prev.phase !== "failed") {
          // A second run starting while the first is still live: the newest wins.
          if (prev.updatedAt > Date.now() - 60_000) return prev;
        }
        const members = Array.isArray(payload.members)
          ? (payload.members as Array<Record<string, unknown>>).map((member) => ({
              expert: asString(member.expert) ?? "",
              status: asString(member.status) ?? "pending",
            }))
          : prev?.members ?? [];
        const stageRaw = payload.stage as Record<string, unknown> | undefined;
        return {
          runId: event.runId,
          teamName: asString(payload.team) ?? prev?.teamName ?? "",
          phase: asString(payload.phase) ?? prev?.phase ?? "planning",
          members,
          totalTokens: asNumber(payload.totalTokens) ?? prev?.totalTokens ?? 0,
          budgetTokens: asNumber(payload.budgetTokens) ?? prev?.budgetTokens,
          stage: stageRaw
            ? {
                index: asNumber(stageRaw.index) ?? 0,
                total: asNumber(stageRaw.total) ?? 0,
                name: asString(stageRaw.name) ?? "",
                round: asNumber(stageRaw.round),
                maxRounds: asNumber(stageRaw.maxRounds),
                expert: asString(stageRaw.expert),
              }
            : prev?.stage,
          updatedAt: Date.now(),
        };
      });
    });
    return off;
  }, [sessionId]);

  const live = useMemo(
    () => (run && run.phase !== "done" && run.phase !== "failed" ? run : null),
    [run],
  );

  const phaseKey = (phase: string) => {
    if (phase === "executing") return "expert.phaseExecuting";
    if (phase === "integrating") return "expert.phaseIntegrating";
    if (phase === "failed") return "expert.phaseFailed";
    return "expert.phasePlanning";
  };

  if (!live) return null;
  const budget = live.budgetTokens ?? 0;
  const ratio = budget > 0 ? Math.min(1, live.totalTokens / budget) : 0;

  return (
    <div className="team-run-strip" role="status" data-phase={live.phase}>
      <div className="team-run-strip-head">
        <IconUsers size={13} />
        <span className="team-run-strip-name">{live.teamName}</span>
        <span className="team-run-strip-phase">{t(phaseKey(live.phase))}</span>
        <span className="team-run-strip-tokens">
          {budget > 0
            ? t("expert.budgetUsage", {
                used: live.totalTokens.toLocaleString(),
                budget: budget.toLocaleString(),
              })
            : t("expert.tokensUsed", { used: live.totalTokens.toLocaleString() })}
        </span>
      </div>
      {budget > 0 ? (
        <div className="team-run-strip-budget" aria-hidden>
          <span
            className={ratio >= 1 ? "over" : ratio >= 0.8 ? "warn" : undefined}
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
      ) : null}
      {live.stage ? (
        <div className="team-run-strip-row">
          <span className="team-run-chip running">
            {t("expert.stageLabel", {
              index: live.stage.index + 1,
              total: live.stage.total,
              name: live.stage.name,
            })}
            {live.stage.expert ? ` · ${live.stage.expert}` : ""}
            {live.stage.round != null
              ? ` · ${live.stage.round}/${live.stage.maxRounds ?? "—"}`
              : ""}
          </span>
        </div>
      ) : null}
      {live.members.length ? (
        <div className="team-run-strip-row">
          {live.members.map((member, index) => (
            <span
              key={`${member.expert}-${index}`}
              className={`team-run-chip ${member.status}`}
              data-status={member.status}
            >
              <IconGraduationCap size={11} />
              {member.expert}
              <span className="team-run-chip-glyph">
                {memberStatusGlyph(member.status)}
              </span>
              {member.status === "failed" ? (
                <button
                  type="button"
                  className="team-run-chip-retry"
                  onClick={() =>
                    void api
                      .retryTeamMember({ runId: live.runId, index })
                      .catch(() => undefined)
                  }
                >
                  {t("expert.retryMember")}
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
