import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SpaceNode, SpaceTreeEntry } from "@pi-desktop/shared";
import {
  IconChevronRight,
  IconCode,
  IconFileText,
  IconGlobe,
  IconNewProject,
  IconPencil,
  IconPlus,
  IconSheet,
  IconTrash,
} from "../icons";
import { cx } from "../ui";

export function NodeTypeIcon({ type, size = 14 }: { type: SpaceNode["type"]; size?: number }) {
  if (type === "csv") return <IconSheet size={size} />;
  if (type === "html") return <IconCode size={size} />;
  if (type === "file") return <IconGlobe size={size} />;
  if (type === "folder") return <IconNewProject size={size} />;
  return <IconFileText size={size} />;
}

/**
 * Left-rail document tree (T52.4): builds a hierarchy from the server's
 * parent-before-child flat list and renders expand/collapse folders, type
 * icons, and hover context actions (new child / rename / delete→recycle).
 * Action visibility follows the node's effective perm — the server is still
 * the only judge and answers 403 with a readable reason.
 */
export function SpaceTree(props: {
  nodes: SpaceNode[];
  selectedId: string | null;
  expanded: Set<string>;
  onToggle: (folderId: string) => void;
  onSelect: (node: SpaceNode) => void;
  onNewChild: (folder: SpaceNode) => void;
  onRename: (node: SpaceNode) => void;
  onDelete: (node: SpaceNode) => void;
  disabled?: boolean;
}) {
  const {
    nodes,
    selectedId,
    expanded,
    onToggle,
    onSelect,
    onNewChild,
    onRename,
    onDelete,
    disabled,
  } = props;
  const { t } = useTranslation();

  const roots = useMemo(() => {
    const byParent = new Map<string | null, SpaceNode[]>();
    for (const node of nodes) {
      const key = node.parentId ?? null;
      const list = byParent.get(key) ?? [];
      list.push(node);
      byParent.set(key, list);
    }
    const sort = (list: SpaceNode[]) =>
      list
        .slice()
        .sort(
          (a, b) =>
            a.sortKey - b.sortKey ||
            a.name.localeCompare(b.name) ||
            a.id.localeCompare(b.id),
        );
    const build = (parentId: string | null): SpaceTreeEntry[] =>
      sort(byParent.get(parentId) ?? []).map((node) => ({
        ...node,
        children: build(node.id),
      }));
    return build(null);
  }, [nodes]);

  const canEdit = (node: SpaceNode) =>
    !disabled && node.perm !== "viewer" && node.perm !== "none";

  const renderRow = (entry: SpaceTreeEntry, depth: number): ReactNode => {
    const isFolder = entry.type === "folder";
    const isOpen = expanded.has(entry.id);
    const actions: ReactNode[] = [];
    if (isFolder && canEdit(entry)) {
      actions.push(
        <button
          key="new-child"
          type="button"
          className="rounded-sm p-1 opacity-70 hover:opacity-100"
          title={t("space.newChild")}
          aria-label={t("space.newChild")}
          onClick={(event) => {
            event.stopPropagation();
            onNewChild(entry);
          }}
        >
          <IconPlus size={13} />
        </button>,
      );
    }
    if (canEdit(entry)) {
      actions.push(
        <button
          key="rename"
          type="button"
          className="rounded-sm p-1 opacity-70 hover:opacity-100"
          title={t("space.rename")}
          aria-label={t("space.rename")}
          onClick={(event) => {
            event.stopPropagation();
            onRename(entry);
          }}
        >
          <IconPencil size={13} />
        </button>,
        <button
          key="delete"
          type="button"
          className="rounded-sm p-1 opacity-70 hover:opacity-100"
          title={t("space.delete")}
          aria-label={t("space.delete")}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(entry);
          }}
        >
          <IconTrash size={13} />
        </button>,
      );
    }

    return (
      <li key={entry.id}>
        <div
          className={cx(
            "group flex items-center gap-1 rounded-sm pr-1 text-sm",
            entry.id === selectedId
              ? "bg-[color:var(--ds-bg-inset)] font-medium"
              : "hover:bg-[color:var(--ds-bg-inset)]",
          )}
          style={{ paddingInlineStart: `${depth * 14 + 4}px` }}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-start"
            onClick={() => {
              if (isFolder) onToggle(entry.id);
              onSelect(entry);
            }}
            title={`${entry.name} · ${t(`space.perm.${entry.perm}`, {
              defaultValue: entry.perm,
            })}`}
          >
            {isFolder ? (
              <IconChevronRight
                size={13}
                className={cx("shrink-0 transition-transform", isOpen && "rotate-90")}
              />
            ) : (
              <span className="inline-flex w-[13px] shrink-0 justify-center">
                <NodeTypeIcon type={entry.type} />
              </span>
            )}
            <span className="truncate">{entry.name}</span>
            {entry.commentCount ? (
              <span className="ml-auto shrink-0 rounded-full px-1 text-[10px] opacity-60" title="comments">
                {entry.commentCount}
              </span>
            ) : null}
            {entry.pendingRevisions ? (
              <span className="ml-auto shrink-0 rounded-full bg-amber-500/20 px-1 text-[10px] text-amber-700 dark:text-amber-300" title="pending revisions">
                {entry.pendingRevisions}
              </span>
            ) : null}
          </button>
          <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
            {actions}
          </span>
        </div>
        {isFolder && isOpen && entry.children.length > 0 ? (
          <ul>{entry.children.map((child) => renderRow(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  if (roots.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs opacity-60">
        <IconNewProject size={18} />
        <span>{t("space.treeEmpty")}</span>
      </div>
    );
  }

  return <ul>{roots.map((entry) => renderRow(entry, 0))}</ul>;
}
