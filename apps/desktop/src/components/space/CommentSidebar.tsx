import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SpaceComment, SpaceNode } from "@pi-desktop/shared";
import { IconChat, IconCheckCheck, IconUndo2 } from "../icons";
import { Button, cx } from "../ui";

export interface CommentThread {
  root: SpaceComment;
  replies: SpaceComment[];
}

export function groupThreads(comments: SpaceComment[]): CommentThread[] {
  const roots = comments.filter((c) => c.parentId === null);
  const byRoot = new Map<string, SpaceComment[]>();
  for (const comment of comments) {
    if (comment.parentId === null) continue;
    const key = comment.parentId;
    const list = byRoot.get(key) ?? [];
    list.push(comment);
    byRoot.set(key, list);
  }
  return roots.map((root) => ({ root, replies: byRoot.get(root.id) ?? [] }));
}

/**
 * Whether a text anchor still resolves against the current content — the
 * renderer-side check for「位置已变化」(SPEC §2). Prefix match inside the
 * paraIndex line-block; the server's accept path re-verifies with sha256.
 */
export function anchorStatus(
  comment: SpaceComment,
  content: string,
): "none" | "anchored" | "missing" {
  const anchor = comment.anchor as
    | { kind?: string; paraIndex?: unknown; textPrefix?: unknown }
    | null;
  if (!anchor || anchor.kind !== "text") return "none";
  const lines = content.split("\n");
  const paraIndex =
    typeof anchor.paraIndex === "number" ? anchor.paraIndex : -1;
  const line = paraIndex >= 0 && paraIndex < lines.length ? lines[paraIndex]! : "";
  const prefix = typeof anchor.textPrefix === "string" ? anchor.textPrefix : "";
  return prefix && line.includes(prefix) ? "anchored" : "missing";
}

/**
 * Comment threads for the active MD doc (T52.8): reply, resolve/reopen, and
 * anchor state shown as「位置已变化」when the selection's line no longer
 * holds the captured prefix.
 */
export function CommentSidebar(props: {
  node: SpaceNode | null;
  threads: CommentThread[];
  content: string;
  busy: boolean;
  onReply: (rootId: string, body: string) => Promise<void>;
  onResolve: (rootId: string, status: "open" | "resolved") => Promise<void>;
}) {
  const { node, threads, content, busy, onReply, onResolve } = props;
  const { t } = useTranslation();
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [showResolved, setShowResolved] = useState(false);

  const visible = useMemo(
    () =>
      threads
        .filter((thread) => showResolved || thread.root.status === "open")
        .sort((a, b) => a.root.createdAt.localeCompare(b.root.createdAt)),
    [threads, showResolved],
  );

  const openCount = threads.filter((thread) => thread.root.status === "open").length;

  const submitReply = async (rootId: string) => {
    const body = replyText.trim();
    if (!body) return;
    await onReply(rootId, body);
    setReplyText("");
    setReplyTo(null);
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <span className="text-xs font-medium">
          {t("space.comments.title")}
          <span className="ml-1 opacity-60">
            ({openCount > 0 ? t("space.comments.openCount", { count: openCount }) : t("space.comments.noneOpen")})
          </span>
        </span>
        <button
          type="button"
          className="text-xs opacity-60 hover:opacity-100"
          onClick={() => setShowResolved((value) => !value)}
        >
          {showResolved ? t("space.comments.hideResolved") : t("space.comments.showResolved")}
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs opacity-60">
          <IconChat size={18} />
          <span>{t("space.comments.empty")}</span>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2">
          {visible.map(({ root, replies }) => {
            const status = anchorStatus(root, content);
            return (
              <li
                key={root.id}
                className={cx(
                  "rounded-md border p-2",
                  root.status === "resolved" && "opacity-55",
                  status === "missing" && "border-dashed",
                )}
                style={{ borderColor: "var(--ds-border-default)" }}
              >
                <div className="mb-1 flex items-center gap-2 text-xs opacity-70">
                  <IconChat size={12} />
                  <span className="truncate">
                    {status === "anchored"
                      ? t("space.comments.anchoredAt", {
                          line: (root.anchor as { paraIndex?: number })?.paraIndex ?? 0,
                        })
                      : status === "missing"
                        ? t("space.comments.anchorMissing")
                        : ""}
                  </span>
                  {status === "anchored" ? (
                    <span className="truncate opacity-80">
                      “{(root.anchor as { textPrefix?: string })?.textPrefix ?? ""}”
                    </span>
                  ) : null}
                </div>
                <p className={cx("whitespace-pre-wrap text-sm", root.status === "resolved" && "line-through")}>
                  {root.body}
                </p>
                {replies.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1 border-t pt-2 text-sm" style={{ borderColor: "var(--ds-border-subtle)" }}>
                    {replies.map((reply) => (
                      <li key={reply.id} className="whitespace-pre-wrap opacity-85">
                        {reply.body}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-2 flex items-center gap-1.5">
                  {replyTo === root.id ? (
                    <span className="flex min-w-0 flex-1 items-center gap-1">
                      <input
                        className="field-input text-xs"
                        autoFocus
                        value={replyText}
                        placeholder={t("space.comments.replyPlaceholder")}
                        onChange={(event) => setReplyText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            void submitReply(root.id);
                          }
                          if (event.key === "Escape") {
                            setReplyTo(null);
                            setReplyText("");
                          }
                        }}
                      />
                    </span>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || node?.perm === "viewer"}
                    onClick={() => {
                      setReplyTo(replyTo === root.id ? null : root.id);
                      setReplyText("");
                    }}
                  >
                    {t("space.comments.reply")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || node?.perm === "viewer"}
                    title={root.status === "open" ? t("space.comments.resolve") : t("space.comments.reopen")}
                    onClick={() =>
                      void onResolve(root.id, root.status === "open" ? "resolved" : "open")
                    }
                  >
                    {root.status === "open" ? (
                      <IconCheckCheck size={13} />
                    ) : (
                      <IconUndo2 size={13} />
                    )}
                    {root.status === "open" ? t("space.comments.resolve") : t("space.comments.reopen")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
