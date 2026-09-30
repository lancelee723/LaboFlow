import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  SpaceComment,
  SpaceDoc,
  SpaceDto,
  SpaceNode,
  SpaceNodeType,
  RevisionSuggestion,
} from "@pi-desktop/shared";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { Badge, Button, cx } from "../components/ui";
import {
  IconArchive,
  IconArchiveRestore,
  IconNewProject,
  IconPlus,
  IconRefresh,
  IconTriangleAlert,
  IconUser,
  IconUsers,
} from "../components/icons";
import { SpaceTree } from "../components/space/SpaceTree";
import { MdDocEditor } from "../components/space/MdDocEditor";
import { CsvEditor } from "../components/space/CsvEditor";
import { HtmlCollabEditor } from "../components/space/HtmlCollabEditor";
import { CommentSidebar, groupThreads } from "../components/space/CommentSidebar";
import { RevisionPanel } from "../components/space/RevisionPanel";

type PromptDialog =
  | { kind: "new-space"; value: string }
  | { kind: "new-node"; parentId: string | null; types: SpaceNodeType[]; value: string; nodeType: SpaceNodeType }
  | { kind: "rename"; node: SpaceNode; value: string }
  | { kind: "confirm-delete"; node: SpaceNode };

/**
 * Team Spaces page (T52.4-10 client slice, FR-TC-01/03/08/09/10/20 v1):
 * left rail = space list + document tree (+ trash view); center = content by
 * node type; right rail = comments + revision suggestions for MD docs. All
 * server errors surface as readable toasts plus a degraded banner (SPEC
 * offline-only degradation); events for the ACTIVE space arrive through
 * onSpaceEvent and refresh tree/doc/comments/revisions.
 */
export function SpacePage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);

  const [connected, setConnected] = useState<boolean | null>(null);
  const [spaces, setSpaces] = useState<SpaceDto[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<SpaceNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doc, setDoc] = useState<SpaceDoc | null>(null);
  const [comments, setComments] = useState<SpaceComment[]>([]);
  const [revisions, setRevisions] = useState<RevisionSuggestion[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [recycleMode, setRecycleMode] = useState(false);
  const [trashed, setTrashed] = useState<Array<{ id: string; name: string; type: SpaceNodeType }>>([]);
  const [dialog, setDialog] = useState<PromptDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"comments" | "revisions">("comments");
  const [reloadTick, setReloadTick] = useState(0);
  const toastRef = useRef(showToast);
  toastRef.current = showToast;

  const toast = useCallback(
    (message: string, variant: "info" | "error" | "success" = "info") => {
      toastRef.current(message, { variant: variant === "info" ? "info" : variant });
    },
    [],
  );

  const fail = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setDegraded(message);
    toastRef.current(message, { variant: "error" });
  }, []);

  // ---------------------------------------------------------------- loaders

  useEffect(() => {
    let cancelled = false;
    api
      .orgStatus()
      .then((status) => {
        if (cancelled) return;
        setConnected(status.state === "connected");
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadSpaces = useCallback(async () => {
    try {
      const rows = await api.listSpaces();
      setSpaces(rows);
      setDegraded(null);
      setActiveSpaceId((current) =>
        current && rows.some((space) => space.id === current) ? current : (rows[0]?.id ?? null),
      );
    } catch (error) {
      fail(error);
    }
  }, [fail]);

  const loadTree = useCallback(async () => {
    if (!activeSpaceId) {
      setNodes([]);
      return;
    }
    try {
      const rows = await api.spaceTree(activeSpaceId);
      setNodes(rows);
      setDegraded(null);
    } catch (error) {
      fail(error);
    }
  }, [activeSpaceId, fail]);

  const loadComments = useCallback(async () => {
    if (!activeSpaceId || !selectedId) {
      setComments([]);
      return;
    }
    try {
      setComments(await api.spaceCommentsList({ spaceId: activeSpaceId, nodeId: selectedId }));
    } catch (error) {
      fail(error);
    }
  }, [activeSpaceId, selectedId, fail]);

  const loadRevisions = useCallback(async () => {
    if (!activeSpaceId || !selectedId) {
      setRevisions([]);
      return;
    }
    try {
      setRevisions(await api.spaceRevisionsList({ spaceId: activeSpaceId, nodeId: selectedId }));
    } catch (error) {
      fail(error);
    }
  }, [activeSpaceId, selectedId, fail]);

  useEffect(() => {
    void loadSpaces();
  }, [loadSpaces]);

  useEffect(() => {
    void loadTree();
  }, [loadTree, reloadTick]);

  useEffect(() => {
    setDoc(null);
    setComments([]);
    setRevisions([]);
    if (!selectedId) return;
    void loadComments();
    void loadRevisions();
    // Doc content itself is owned by the editor component (node.id effect).
  }, [selectedId, loadComments, loadRevisions]);

  const activeSpace = spaces.find((space) => space.id === activeSpaceId) ?? null;
  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null;
  const canEditActive =
    activeSpace !== null &&
    !activeSpace.archivedAt &&
    selectedNode?.perm !== "viewer" &&
    selectedNode?.perm !== "none";

  // ---------------------------------------------------------------- events

  useEffect(() => {
    if (!activeSpaceId) return;
    void api.spaceEventsSubscribe(activeSpaceId).catch(() => undefined);
    const off = api.onSpaceEvent((frame) => {
      if (frame.spaceId !== activeSpaceId) return;
      const payloadNodeId =
        typeof (frame.payload as { nodeId?: unknown })?.nodeId === "string"
          ? ((frame.payload as { nodeId: string }).nodeId)
          : null;
      if (frame.type === "doc.version") {
        if (payloadNodeId && payloadNodeId === selectedId) {
          void api
            .spaceDocGet({ spaceId: activeSpaceId, nodeId: payloadNodeId })
            .then(setDoc)
            .catch(() => undefined);
        }
        void loadRevisions();
      } else if (frame.type.startsWith("comment.")) {
        void loadComments();
      } else if (frame.type.startsWith("revision.")) {
        void loadRevisions();
      } else if (frame.type.startsWith("node.")) {
        void loadTree();
      }
    });
    return () => {
      off();
      void api.spaceEventsUnsubscribe(activeSpaceId).catch(() => undefined);
    };
  }, [activeSpaceId, selectedId, loadComments, loadRevisions, loadTree]);

  // ---------------------------------------------------------------- actions

  const submitDialog = async () => {
    if (!dialog || busy) return;
    const name = dialog.kind === "confirm-delete" ? "" : dialog.value.trim();
    setBusy(true);
    try {
      if (dialog.kind === "new-space") {
        if (!name) throw new Error(t("space.nameRequired"));
        const created = await api.createSpace({ name });
        setActiveSpaceId(created.id);
        setNodes([]);
        setSelectedId(null);
        await loadSpaces();
        toast(t("space.createdToast"), "success");
      } else if (dialog.kind === "new-node") {
        if (!activeSpaceId) return;
        if (!name) throw new Error(t("space.nameRequired"));
        const created = await api.spaceNodeCreate({
          spaceId: activeSpaceId,
          parentId: dialog.parentId,
          type: dialog.nodeType,
          name,
        });
        if (dialog.parentId) {
          setExpanded((prev) => new Set(prev).add(dialog.parentId!));
        }
        setSelectedId(created.id);
        await loadTree();
        toast(t("space.createdToast"), "success");
      } else if (dialog.kind === "rename") {
        if (!activeSpaceId) return;
        if (!name) throw new Error(t("space.nameRequired"));
        await api.spaceNodeRename({ spaceId: activeSpaceId, nodeId: dialog.node.id, name });
        await loadTree();
      } else if (dialog.kind === "confirm-delete") {
        if (!activeSpaceId) return;
        await api.spaceNodeDelete({ spaceId: activeSpaceId, nodeId: dialog.node.id });
        setTrashed((prev) =>
          prev.some((item) => item.id === dialog.node.id)
            ? prev
            : [...prev, { id: dialog.node.id, name: dialog.node.name, type: dialog.node.type }],
        );
        if (selectedId === dialog.node.id) setSelectedId(null);
        await loadTree();
        toast(t("space.nodeDeleted"), "success");
      }
      setDialog(null);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const restoreFromTrash = async (nodeId: string) => {
    if (!activeSpaceId || busy) return;
    setBusy(true);
    try {
      await api.spaceNodeRestore({ spaceId: activeSpaceId, nodeId });
      setTrashed((prev) => prev.filter((item) => item.id !== nodeId));
      await loadTree();
      toast(t("space.nodeRestored"), "success");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const reviewByComments = async () => {
    if (!activeSpaceId || !selectedId || busy) return;
    setBusy(true);
    try {
      const created = await api.spaceReviewByComments({ spaceId: activeSpaceId, nodeId: selectedId });
      await loadRevisions();
      setRightTab("revisions");
      toast(t("space.revisions.reviewDone", { count: created.length }), "success");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const decideRevision = async (id: string, decision: "accepted" | "rejected") => {
    if (!activeSpaceId || !selectedId || busy) return;
    setBusy(true);
    try {
      const result = await api.spaceRevisionDecide({
        spaceId: activeSpaceId,
        nodeId: selectedId,
        suggestionId: id,
        decision,
      });
      await loadRevisions();
      if (decision === "accepted" && typeof result.appliedVersion === "number") {
        if (selectedNode && selectedNode.type === "md") {
          void api
            .spaceDocGet({ spaceId: activeSpaceId, nodeId: selectedId })
            .then(setDoc)
            .catch(() => undefined);
        }
        toast(t("space.revisions.applied", { version: result.appliedVersion }), "success");
      }
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const threads = useMemo(() => groupThreads(comments), [comments]);

  // ---------------------------------------------------------------- render

  if (connected === false) {
    return (
      <div className="settings-stack">
        <section className="settings-card-block">
          <h3 className="settings-card-heading">{t("space.title")}</h3>
          <div className="settings-panel">
            <div className="model-provider-empty">
              <div className="model-provider-empty-icon" aria-hidden>
                <IconUser size={18} />
              </div>
              <div className="model-provider-empty-title">{t("workspaces.signInFirst")}</div>
              <div className="model-provider-empty-desc">{t("workspaces.signInHint")}</div>
              <Button
                variant="primary"
                onClick={() => {
                  // TODO(sync-v0.15.10 Task 0): org settings tab pending re-wire
                  useAppStore.getState().setPage("settings");
                }}
              >
                {t("settings.nav.org")}
              </Button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const dialogTitle = (current: PromptDialog): string => {
    if (current.kind === "new-space") return t("space.newSpace");
    if (current.kind === "rename") return t("space.rename");
    if (current.kind === "confirm-delete")
      return t("space.deleteConfirm", { name: current.node.name });
    return current.parentId ? t("space.newChild") : t("space.newDoc");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      {degraded ? (
        <div
          className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs"
          style={{ borderColor: "var(--ds-border-strong)" }}
          role="status"
        >
          <IconTriangleAlert size={13} />
          <span>{t("space.offline")}</span>
          <span className="truncate opacity-60">{degraded}</span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-3">
        {/* ---------------- left rail: spaces + tree ---------------- */}
        <aside className="flex w-64 min-w-52 shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border p-2" style={{ borderColor: "var(--ds-border-subtle)" }}>
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs font-medium uppercase tracking-wide opacity-60">
              {t("space.spaces")}
            </span>
            <button
              type="button"
              className="rounded-sm p-1 opacity-70 hover:opacity-100"
              title={t("space.newSpace")}
              aria-label={t("space.newSpace")}
              onClick={() => setDialog({ kind: "new-space", value: "" })}
            >
              <IconPlus size={13} />
            </button>
          </div>

          {spaces.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-2 py-4 text-center text-xs opacity-60">
              <IconUsers size={18} />
              <span>{t("space.empty")}</span>
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {spaces.map((space) => (
                <li key={space.id}>
                  <button
                    type="button"
                    className={cx(
                      "flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-start text-sm",
                      space.id === activeSpaceId
                        ? "bg-[color:var(--ds-bg-inset)] font-medium"
                        : "hover:bg-[color:var(--ds-bg-inset)]",
                    )}
                    onClick={() => {
                      setActiveSpaceId(space.id);
                      setSelectedId(null);
                      setTrashed([]);
                    }}
                  >
                    <IconUsers size={13} />
                    <span className="min-w-0 flex-1 truncate">{space.name}</span>
                    {space.archivedAt ? (
                      <Badge tone="neutral">{t("space.archived")}</Badge>
                    ) : (
                      <span className="text-xs opacity-50">
                        {t(`space.perm.${space.myPerm}`, { defaultValue: space.myPerm })}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between gap-1 border-t pt-2" style={{ borderColor: "var(--ds-border-subtle)" }}>
            <span className="text-xs font-medium uppercase tracking-wide opacity-60">
              {recycleMode ? t("space.recycle") : t("space.tree")}
            </span>
            <span className="flex items-center gap-0.5">
              {!recycleMode && activeSpaceId && !activeSpace?.archivedAt && activeSpace?.myPerm !== "viewer" ? (
                <button
                  type="button"
                  className="rounded-sm p-1 opacity-70 hover:opacity-100"
                  title={t("space.newDoc")}
                  aria-label={t("space.newDoc")}
                  onClick={() =>
                    setDialog({
                      kind: "new-node",
                      parentId: null,
                      types: ["folder", "md", "csv", "html"],
                      value: "",
                      nodeType: "md",
                    })
                  }
                >
                  <IconPlus size={13} />
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-sm p-1 opacity-70 hover:opacity-100"
                title={t("space.refresh")}
                aria-label={t("space.refresh")}
                onClick={() => setReloadTick((value) => value + 1)}
              >
                <IconRefresh size={13} />
              </button>
              <button
                type="button"
                className={cx(
                  "rounded-sm p-1 hover:opacity-100",
                  recycleMode ? "opacity-100" : "opacity-70",
                )}
                title={recycleMode ? t("space.backToTree") : t("space.recycle")}
                aria-label={recycleMode ? t("space.backToTree") : t("space.recycle")}
                onClick={() => setRecycleMode((value) => !value)}
              >
                <IconArchive size={13} />
              </button>
            </span>
          </div>

          {recycleMode ? (
            trashed.length === 0 ? (
              <div className="px-2 py-4 text-center text-xs opacity-60">{t("space.recycleEmpty")}</div>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {trashed.map((item) => (
                  <li key={item.id} className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-sm opacity-80">
                    <span className="min-w-0 flex-1 truncate line-through">{item.name}</span>
                    <button
                      type="button"
                      className="rounded-sm p-1 opacity-70 hover:opacity-100"
                      title={t("space.restore")}
                      aria-label={t("space.restore")}
                      disabled={busy}
                      onClick={() => void restoreFromTrash(item.id)}
                    >
                      <IconArchiveRestore size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <SpaceTree
              nodes={nodes}
              selectedId={selectedId}
              expanded={expanded}
              onToggle={(folderId) =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(folderId)) {
                    next.delete(folderId);
                  } else {
                    next.add(folderId);
                  }
                  return next;
                })
              }
              onSelect={(node) => setSelectedId(node.id)}
              onNewChild={(folder) =>
                setDialog({
                  kind: "new-node",
                  parentId: folder.id,
                  types: ["folder", "md", "csv", "html"],
                  value: "",
                  nodeType: "md",
                })
              }
              onRename={(node) => setDialog({ kind: "rename", node, value: node.name })}
              onDelete={(node) => setDialog({ kind: "confirm-delete", node })}
              disabled={!activeSpaceId || Boolean(activeSpace?.archivedAt)}
            />
          )}

          <span className="mt-auto text-center text-xs opacity-40" title={t("space.uploadNextBatch")}>
            <button
              type="button"
              className="w-full rounded-sm border border-dashed px-2 py-1.5 opacity-70"
              disabled
              title={t("space.uploadNextBatch")}
            >
              {t("space.upload")}
            </button>
          </span>
        </aside>

        {/* ---------------- center: content by node type ---------------- */}
        <section className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">
              {selectedNode
                ? selectedNode.name
                : activeSpace
                  ? activeSpace.name
                  : t("space.title")}
            </span>
            {selectedNode ? (
              <Badge tone="neutral">
                {t(`space.type.${selectedNode.type}`, { defaultValue: selectedNode.type })}
              </Badge>
            ) : null}
            {activeSpace?.archivedAt ? <Badge tone="warning">{t("space.archived")}</Badge> : null}
          </div>

          {!activeSpaceId ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm opacity-60">
              <IconNewProject size={22} />
              {t("space.empty")}
            </div>
          ) : !selectedNode ? (
            <div className="flex flex-1 items-center justify-center text-sm opacity-60">
              {recycleMode ? t("space.recycleHint") : t("space.emptySelectionArea")}
            </div>
          ) : selectedNode.type === "md" ? (
            <MdDocEditor
              key={selectedNode.id}
              spaceId={activeSpaceId}
              node={selectedNode}
              doc={doc?.nodeId === selectedNode.id ? doc : null}
              canEdit={canEditActive}
              onToast={toast}
              onDocLoaded={setDoc}
              onCommentsChanged={() => void loadComments()}
              onRevisionsChanged={() => {
                void loadRevisions();
                setRightTab("revisions");
              }}
            />
          ) : selectedNode.type === "csv" ? (
            <CsvEditor
              key={selectedNode.id}
              spaceId={activeSpaceId}
              node={selectedNode}
              doc={doc?.nodeId === selectedNode.id ? doc : null}
              canEdit={canEditActive}
              onToast={toast}
              onDocLoaded={setDoc}
            />
          ) : selectedNode.type === "html" ? (
            <HtmlCollabEditor node={selectedNode} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed text-center" style={{ borderColor: "var(--ds-border-strong)" }}>
              <span className="text-sm">{selectedNode.name}</span>
              <span className="max-w-md text-xs opacity-60">{t("space.file.placeholder")}</span>
            </div>
          )}
        </section>

        {/* ---------------- right rail: comments + revisions ---------------- */}
        {selectedNode?.type === "md" ? (
          <aside className="flex w-80 min-w-72 shrink-0 flex-col rounded-lg border p-2" style={{ borderColor: "var(--ds-border-subtle)" }}>
            <div className="workspaces-tabs mb-2" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={rightTab === "comments"}
                className={rightTab === "comments" ? "is-active" : ""}
                onClick={() => setRightTab("comments")}
              >
                {t("space.comments.title")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rightTab === "revisions"}
                className={rightTab === "revisions" ? "is-active" : ""}
                onClick={() => setRightTab("revisions")}
              >
                {t("space.revisions.title")}
              </button>
            </div>
            {rightTab === "comments" ? (
              <CommentSidebar
                node={selectedNode}
                threads={threads}
                content={doc?.nodeId === selectedNode.id ? (doc?.content ?? "") : ""}
                busy={busy}
                onReply={async (rootId, body) => {
                  if (!activeSpaceId) return;
                  try {
                    await api.spaceCommentReply({
                      spaceId: activeSpaceId,
                      nodeId: selectedNode.id,
                      commentId: rootId,
                      body,
                    });
                    await loadComments();
                  } catch (error) {
                    fail(error);
                  }
                }}
                onResolve={async (rootId, status) => {
                  if (!activeSpaceId) return;
                  try {
                    await api.spaceCommentResolve({
                      spaceId: activeSpaceId,
                      nodeId: selectedNode.id,
                      commentId: rootId,
                      status,
                    });
                    await loadComments();
                  } catch (error) {
                    fail(error);
                  }
                }}
              />
            ) : (
              <RevisionPanel
                suggestions={revisions}
                nodePerm={selectedNode.perm === "none" ? "none" : selectedNode.perm}
                myUserId=""
                busy={busy}
                onDecide={decideRevision}
                onReviewByComments={reviewByComments}
              />
            )}
          </aside>
        ) : null}
      </div>

      {/* ---------------- prompt / confirm dialog ---------------- */}
      {dialog ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setDialog(null)}
        >
          <div
            className="flex w-96 max-w-full flex-col gap-3 rounded-lg border bg-[color:var(--ds-bg-elevated-opaque)] p-4"
            style={{ borderColor: "var(--ds-border-default)" }}
            onClick={(event) => event.stopPropagation()}
          >
            <span className="text-sm font-medium">{dialogTitle(dialog)}</span>
            {dialog.kind === "new-node" ? (
              <div className="flex gap-1">
                {dialog.types.map((type) => (
                  <Button
                    key={type}
                    size="sm"
                    variant={dialog.nodeType === type ? "primary" : "ghost"}
                    onClick={() => setDialog({ ...dialog, nodeType: type })}
                  >
                    {t(`space.type.${type}`, { defaultValue: type })}
                  </Button>
                ))}
              </div>
            ) : null}
            {dialog.kind !== "confirm-delete" ? (
              <input
                className="field-input text-sm"
                autoFocus
                value={dialog.value}
                placeholder={dialog.kind === "new-space" ? t("space.spaceName") : t("space.nodeName")}
                onChange={(event) =>
                  setDialog({ ...dialog, value: event.target.value } as PromptDialog)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submitDialog();
                  }
                  if (event.key === "Escape") setDialog(null);
                }}
              />
            ) : null}
            <div className="flex items-center justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setDialog(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                variant={dialog.kind === "confirm-delete" ? "primary" : "primary"}
                disabled={busy || (dialog.kind !== "confirm-delete" && !dialog.value.trim())}
                onClick={() => void submitDialog()}
              >
                {dialog.kind === "confirm-delete" ? t("space.delete") : t("space.create")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
