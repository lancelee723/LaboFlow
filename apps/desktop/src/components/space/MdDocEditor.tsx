import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SpaceAnchor, SpaceDoc, SpaceNode, SpaceTextAnchor } from "@pi-desktop/shared";
import { Markdown } from "../Markdown";
import { api } from "../../lib/api";
import { Button, cx } from "../ui";
import { IconChat, IconPencil, IconRefresh, IconSparkles } from "../icons";

/** Renderer sha256 (Web Crypto) — must match the main-side anchor helper. */
async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * MD doc editor (T52.7/8/9 v1): plain textarea + preview toggle, textarea
 * selection → anchor {kind:"text", paraIndex, textPrefix, textHash} → comment
 * or revision suggestion. v1 deliberate choices:
 *  - undo stays the textarea's native stack (no mixed AI/manual undo yet);
 *  - "AI 改写" is user-mediated: the dialog collects the revised text +
 *    rationale and posts producedBy:"user"; the agent pipeline lands later;
 *  - accept/reject happens in the RevisionPanel; the server applies the text
 *    with serial anchor merging and surfaces 409 EANCHOR on drift.
 */
export function MdDocEditor(props: {
  spaceId: string;
  node: SpaceNode;
  doc: SpaceDoc | null;
  canEdit: boolean;
  onToast: (message: string, variant?: "info" | "error" | "success") => void;
  onDocLoaded: (doc: SpaceDoc) => void;
  onCommentsChanged: () => void;
  onRevisionsChanged: () => void;
}) {
  const {
    spaceId,
    node,
    doc,
    canEdit,
    onToast,
    onDocLoaded,
    onCommentsChanged,
    onRevisionsChanged,
  } = props;
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState("");
  const [savedVersion, setSavedVersion] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commentDraft, setCommentDraft] = useState<string | null>(null);
  const [revisionDraft, setRevisionDraft] = useState<string | null>(null);
  const [revisionRationale, setRevisionRationale] = useState("");

  const content = doc?.content ?? "";

  // Load the doc body on node change / external doc.version events.
  const reload = useCallback(
    async (keepDraft: boolean) => {
      try {
        const fresh = await api.spaceDocGet({ spaceId, nodeId: node.id });
        onDocLoaded(fresh);
        setConflict(false);
        if (!keepDraft) {
          setDraft(fresh.content);
          setSavedVersion(fresh.version);
        }
      } catch (error) {
        onToast(error instanceof Error ? error.message : String(error), "error");
      }
    },
    [spaceId, node.id, onDocLoaded, onToast],
  );

  useEffect(() => {
    setDraft("");
    setCommentDraft(null);
    setRevisionDraft(null);
    setPreview(false);
    void reload(false);
    // reload() closes over toast/doc callbacks that change identity per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const dirty = draft !== content || savedVersion !== (doc?.version ?? 0);

  /** Selection captured from the textarea (划词). */
  const selection = (): { text: string; start: number } | null => {
    const el = textareaRef.current;
    if (!el) return null;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = el.value.slice(start, end);
    if (!text.trim()) return null;
    return { text, start };
  };

  /** SPEC §2 anchor: paraIndex = line index of the selection start. */
  const buildAnchor = async (
    text: string,
    start: number,
  ): Promise<SpaceTextAnchor> => {
    const prefix = textareaRef.current?.value.slice(0, start) ?? "";
    return {
      kind: "text",
      paraIndex: prefix.split("\n").length - 1,
      textPrefix: text.slice(0, 64),
      textHash: await sha256Hex(text),
    };
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await api.spaceDocSave({
        spaceId,
        nodeId: node.id,
        content: draft,
        baseVersion: savedVersion,
      });
      setSavedVersion(result.version);
      setConflict(false);
      onDocLoaded({
        nodeId: node.id,
        version: result.version,
        content: draft,
        sha256: result.sha256,
        authorId: null,
        source: (result.source ?? null) as SpaceDoc["source"],
        createdAt: doc?.createdAt ?? null,
        currentVersion: result.version,
      });
      onToast(t("space.doc.saved", { version: result.version }), "success");
    } catch (error) {
      if ((error as { code?: string }).code === "EVERSION") {
        setConflict(true);
        onToast(t("space.doc.conflict"), "error");
      } else {
        onToast(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      setSaving(false);
    }
  };

  const submitComment = async () => {
    const picked = selection();
    const body = (commentDraft ?? "").trim();
    if (!picked) {
      onToast(t("space.selectFirst"), "error");
      return;
    }
    if (!body) return;
    setBusy(true);
    try {
      const anchor = await buildAnchor(picked.text, picked.start);
      await api.spaceCommentCreate({ spaceId, nodeId: node.id, body, anchor });
      setCommentDraft(null);
      onCommentsChanged();
      onToast(t("space.comments.created"), "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const submitRevision = async () => {
    const picked = selection();
    const revised = (revisionDraft ?? "").replace(/\s+$/, "");
    if (!picked) {
      onToast(t("space.selectFirst"), "error");
      return;
    }
    if (!revised || revised === picked.text) return;
    setBusy(true);
    try {
      const anchor: SpaceAnchor = await buildAnchor(picked.text, picked.start);
      await api.spaceRevisionCreate({
        spaceId,
        nodeId: node.id,
        anchor,
        originalText: picked.text,
        revisedText: revised,
        rationale: revisionRationale.trim(),
        producedBy: "user",
      });
      setRevisionDraft(null);
      setRevisionRationale("");
      onRevisionsChanged();
      onToast(t("space.revisions.created"), "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {canEdit ? (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={saving || !dirty}
              onClick={() => void save()}
            >
              {saving ? t("space.doc.saving") : t("space.doc.save")}
              {dirty ? " •" : ""}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              title={t("space.comments.commentSelection")}
              onClick={() => {
                if (!selection()) {
                  onToast(t("space.selectFirst"), "error");
                  return;
                }
                setCommentDraft(commentDraft === null ? "" : commentDraft);
              }}
            >
              <IconChat size={13} />
              {t("space.comments.commentSelection")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              title={t("space.revisions.suggest")}
              onClick={() => {
                if (!selection()) {
                  onToast(t("space.selectFirst"), "error");
                  return;
                }
                setRevisionDraft(revisionDraft === null ? "" : revisionDraft);
              }}
            >
              <IconSparkles size={13} />
              {t("space.revisions.suggest")}
            </Button>
          </>
        ) : (
          <span className="text-xs opacity-60">{t("space.doc.viewerHint")}</span>
        )}
        <span className="flex-1" />
        {conflict || savedVersion !== (doc?.version ?? 0) ? (
          <Button
            size="sm"
            variant="secondary"
            title={t("space.doc.conflictHint")}
            onClick={() => void reload(draft !== content)}
          >
            <IconRefresh size={13} />
            {t("space.doc.reload")}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setPreview((value) => !value)}>
          <IconPencil size={13} />
          {preview ? t("space.doc.edit") : t("space.doc.preview")}
        </Button>
        <span className="text-xs opacity-50">
          {t("space.doc.version", { version: doc?.version ?? 0 })}
        </span>
      </div>

      {conflict ? (
        <div
          className="rounded-md border border-dashed px-3 py-2 text-xs"
          style={{ borderColor: "var(--ds-border-strong)" }}
        >
          {t("space.doc.conflictHint")}
        </div>
      ) : null}

      {commentDraft !== null ? (
        <div className="flex items-center gap-1.5">
          <input
            className="field-input flex-1 text-sm"
            autoFocus
            value={commentDraft}
            placeholder={t("space.comments.placeholder")}
            onChange={(event) => setCommentDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitComment();
              }
              if (event.key === "Escape") setCommentDraft(null);
            }}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !commentDraft.trim()}
            onClick={() => void submitComment()}
          >
            {t("space.comments.submit")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCommentDraft(null)}>
            {t("common.cancel")}
          </Button>
        </div>
      ) : null}

      {revisionDraft !== null ? (
        <div
          className="flex flex-col gap-1.5 rounded-md border p-2"
          style={{ borderColor: "var(--ds-border-default)" }}
        >
          <span className="truncate text-xs opacity-60">
            {t("space.revisions.original")}: “{selection()?.text ?? ""}”
          </span>
          <textarea
            className="field-input min-h-16 text-sm"
            autoFocus
            value={revisionDraft}
            placeholder={t("space.revisions.revisedPlaceholder")}
            onChange={(event) => setRevisionDraft(event.target.value)}
          />
          <input
            className="field-input text-sm"
            value={revisionRationale}
            placeholder={t("space.revisions.rationalePlaceholder")}
            onChange={(event) => setRevisionRationale(event.target.value)}
          />
          <span className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !revisionDraft.trim() || revisionDraft === selection()?.text}
              onClick={() => void submitRevision()}
            >
              {t("space.revisions.submit")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRevisionDraft(null)}>
              {t("common.cancel")}
            </Button>
          </span>
        </div>
      ) : null}

      {preview ? (
        <div
          className="min-h-0 flex-1 overflow-y-auto rounded-md border p-3"
          style={{ borderColor: "var(--ds-border-subtle)" }}
        >
          <Markdown source={draft || t("space.doc.empty")} renderDiagrams={false} />
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          className={cx("field-input min-h-0 flex-1 resize-none font-mono text-sm leading-relaxed")}
          value={draft}
          spellCheck={false}
          placeholder={t("space.doc.empty")}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
    </div>
  );
}
