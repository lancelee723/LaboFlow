/**
 * FR-TC-19: the space activity stream — who did what, when (新建/修改/接受),
 * fed by the server's space_events ledger: one history pull on mount, then
 * the live frames the page already receives are folded in (the page owns the
 * buffer; dedupe by seq keeps the two sources from doubling rows). Pure
 * description logic lives in `describeSpaceEvent`/`actorLabel` so the audit
 * text is testable without a server.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SpaceEventFrame, SpaceEventPayload } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import {
  actorLabel,
  describeSpaceEvent,
  type SpaceActivityMember,
} from "./space-activity-describe";

const MAX_ROWS = 80;

function timeLabel(createdAt: string): string {
  const time = Date.parse(createdAt);
  if (Number.isNaN(time)) return "";
  return new Date(time).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SpaceActivityStream({
  spaceId,
  liveFrames,
  members,
}: {
  spaceId: string;
  /** The page's subscription buffer (newest appended last); deduped by seq. */
  liveFrames: readonly SpaceEventFrame[];
  members: readonly SpaceActivityMember[];
}) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<SpaceEventPayload[]>([]);

  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    api
      .spaceEventsPull({ spaceId, since: -1 })
      .then((result) => {
        if (!cancelled) setHistory(result.events ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  const rows = useMemo(() => {
    const bySeq = new Map<number, SpaceEventPayload>();
    for (const frame of liveFrames) bySeq.set(frame.seq, frame);
    for (const event of history) {
      if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
    }
    return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, MAX_ROWS);
  }, [history, liveFrames]);

  return (
    <ul className="min-h-0 flex-1 overflow-auto text-xs" data-testid="space-activity-stream">
      {rows.length === 0 ? (
        <li className="px-2 py-1 opacity-60">{t("space.activity.empty")}</li>
      ) : null}
      {rows.map((event) => (
        <li
          key={event.seq}
          className="flex flex-col gap-0.5 rounded-sm px-2 py-1 hover:bg-black/5"
        >
          <span className="opacity-80">
            <span className="font-medium">{actorLabel(event.actorId, members)}</span>
            <span className="opacity-70">
              {" "}
              {describeSpaceEvent(event.type, event.payload, t)}
            </span>
          </span>
          <span className="opacity-40">{timeLabel(event.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
