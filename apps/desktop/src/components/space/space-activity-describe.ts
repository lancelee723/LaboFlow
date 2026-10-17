/**
 * FR-TC-19 pure half: audit vocabulary + actor resolution for the space
 * activity stream (kept out of the TSX so tests import it without JSX).
 */

export interface SpaceActivityMember {
  userId: string;
  username?: string;
  displayName?: string | null;
}

export function actorLabel(
  actorId: string | null,
  members: readonly SpaceActivityMember[],
): string {
  if (!actorId) return "—";
  const member = members.find((entry) => entry.userId === actorId);
  return member?.displayName?.trim() || member?.username || actorId.slice(0, 8);
}

/** The event types the stream renders, in audit vocabulary. */
export function describeSpaceEvent(
  type: string,
  payload: Record<string, unknown>,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const name = typeof payload?.name === "string" ? payload.name : "";
  const status = typeof payload?.status === "string" ? payload.status : "";
  switch (type) {
    case "space.updated":
      return t("space.activity.spaceUpdated", { name });
    case "member.added":
      return t("space.activity.memberAdded");
    case "member.updated":
      return t("space.activity.memberUpdated");
    case "member.removed":
      return t("space.activity.memberRemoved");
    case "node.created":
      return t("space.activity.nodeCreated", { name });
    case "node.updated":
      return t("space.activity.nodeUpdated", { name });
    case "node.deleted":
      return t("space.activity.nodeDeleted", { name });
    case "node.restored":
      return t("space.activity.nodeRestored");
    case "doc.version":
      return t("space.activity.docVersion");
    case "comment.created":
      return t("space.activity.commentCreated");
    case "comment.replied":
      return t("space.activity.commentReplied");
    case "comment.status":
      return t("space.activity.commentStatus", { status });
    case "revision.created":
      return t("space.activity.revisionCreated");
    case "revision.decided":
      return status
        ? t("space.activity.revisionDecided", {
            decision:
              status === "accepted"
                ? t("space.activity.accepted")
                : t("space.activity.rejected"),
          })
        : t("space.activity.revisionDecidedAny");
    default:
      return type;
  }
}
