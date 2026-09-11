import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RevisionSuggestion } from "@pi-desktop/shared";
import { Badge, Button, cx } from "../ui";
import { IconListChecks, IconCheck, IconClose, IconSparkles } from "../icons";

type DiffRowType = "same" | "add" | "del";
interface DiffRow {
  type: DiffRowType;
  text: string;
}

/**
 * Visual-only LCS line diff for the 原文/改后 card. The authoritative serial
 * merge lives server-side (accept transaction) and in
 * electron/main/space-revisions.ts (tested); this copy just renders rows.
 */
function lineDiff(original: string, revised: string): DiffRow[] {
  const a = original.length ? original.split("\n") : [];
  const b = revised.length ? revised.split("\n") : [];
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i++]! });
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      rows.push({ type: "del", text: a[i++]! });
    } else {
      rows.push({ type: "add", text: b[j++]! });
    }
  }
  while (i < a.length) rows.push({ type: "del", text: a[i++]! });
  while (j < b.length) rows.push({ type: "add", text: b[j++]! });
  return rows;
}

function SuggestionCard(props: {
  suggestion: RevisionSuggestion;
  canDecide: boolean;
  busy: boolean;
  onDecide: (id: string, decision: "accepted" | "rejected") => Promise<void>;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const { suggestion, canDecide, busy, onDecide, t } = props;
  const rows = useMemo(
    () => lineDiff(suggestion.originalText, suggestion.revisedText),
    [suggestion.originalText, suggestion.revisedText],
  );
  const pending = suggestion.status === "pending";

  return (
    <li className="rounded-md border p-2" style={{ borderColor: "var(--ds-border-default)" }}>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        <Badge
          tone={
            suggestion.status === "accepted"
              ? "success"
              : suggestion.status === "rejected"
                ? "neutral"
                : "warning"
          }
        >
          {t(
            suggestion.status === "accepted"
              ? "space.revisions.accepted"
              : suggestion.status === "rejected"
                ? "space.revisions.rejected"
                : "space.revisions.pending",
          )}
        </Badge>
        {suggestion.producedBy === "agent" ? (
          <span className="flex items-center gap-0.5 opacity-70">
            <IconSparkles size={11} />
            {t("space.revisions.byAgent")}
          </span>
        ) : (
          <span className="opacity-70">{t("space.revisions.byUser")}</span>
        )}
        {typeof (suggestion as RevisionSuggestion & { appliedVersion?: number }).appliedVersion ===
        "number" ? (
          <span className="opacity-60">
            {t("space.revisions.applied", {
              version: (suggestion as RevisionSuggestion & { appliedVersion?: number })
                .appliedVersion,
            })}
          </span>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-sm font-mono text-xs">
        {rows
          .filter((row) => row.type !== "same")
          .slice(0, 40)
          .map((row, index) => (
            <div
              key={index}
              className={cx(
                "whitespace-pre-wrap px-1.5 py-0.5",
                row.type === "add" && "bg-success/15",
                row.type === "del" && "bg-error/15 line-through",
              )}
            >
              {row.type === "add" ? "+ " : "− "}
              {row.text}
            </div>
          ))}
        {rows.length === 0 ? <div className="px-1.5 py-0.5 opacity-60">—</div> : null}
      </div>
      {suggestion.rationale ? (
        <p className="mt-1.5 text-xs opacity-70">
          {t("space.revisions.rationale")}: {suggestion.rationale}
        </p>
      ) : null}
      {pending ? (
        <div className="mt-2 flex items-center gap-1.5">
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !canDecide}
            title={canDecide ? undefined : t("space.revisions.decideHint")}
            onClick={() => void onDecide(suggestion.id, "accepted")}
          >
            <IconCheck size={13} />
            {t("space.revisions.accept")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !canDecide}
            title={canDecide ? undefined : t("space.revisions.decideHint")}
            onClick={() => void onDecide(suggestion.id, "rejected")}
          >
            <IconClose size={13} />
            {t("space.revisions.reject")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Revision suggestion panel (T52.9/10): pending cards with 原文/改后 diff and
 * accept/reject (accept → server serial merge; 409 EANCHOR surfaces as the
 * readable conflict toast), plus the 按评论修订 batch button wired to
 * revisions/reviewByComments.
 */
export function RevisionPanel(props: {
  suggestions: RevisionSuggestion[];
  /** Effective perm on the node — contributor decides own requests only. */
  nodePerm: string;
  /** Current org user id (empty when unknown → server still decides). */
  myUserId: string;
  busy: boolean;
  onDecide: (id: string, decision: "accepted" | "rejected") => Promise<void>;
  onReviewByComments: () => Promise<void>;
}) {
  const { suggestions, nodePerm, myUserId, busy, onDecide, onReviewByComments } = props;
  const { t } = useTranslation();
  const [showDecided, setShowDecided] = useState(false);

  const visible = suggestions
    .filter((suggestion) => showDecided || suggestion.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const openCount = suggestions.filter((suggestion) => suggestion.status === "pending").length;

  // SPEC §3.1: manager decides any; contributor only own requests; viewer none.
  const canDecide = (suggestion: RevisionSuggestion) => {
    if (suggestion.status !== "pending") return false;
    if (nodePerm === "manager") return true;
    if (nodePerm === "contributor") {
      return !myUserId || suggestion.requestedBy === myUserId;
    }
    return false;
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <span className="text-xs font-medium">
          {t("space.revisions.title")}
          {openCount > 0 ? (
            <span className="ml-1 opacity-60">({openCount})</span>
          ) : null}
        </span>
        <button
          type="button"
          className="text-xs opacity-60 hover:opacity-100"
          onClick={() => setShowDecided((value) => !value)}
        >
          {showDecided ? t("space.revisions.hideDecided") : t("space.revisions.showDecided")}
        </button>
      </div>

      <Button
        size="sm"
        variant="secondary"
        className="mb-2"
        disabled={busy}
        title={t("space.revisions.reviewByCommentsHint")}
        onClick={() => void onReviewByComments()}
      >
        <IconListChecks size={13} />
        {t("space.revisions.reviewByComments")}
      </Button>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs opacity-60">
          <IconListChecks size={18} />
          <span>{t("space.revisions.empty")}</span>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2">
          {visible.map((suggestion) => (
            <SuggestionCard
              key={suggestion.id}
              suggestion={suggestion}
              canDecide={canDecide(suggestion)}
              busy={busy}
              onDecide={onDecide}
              t={t}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
