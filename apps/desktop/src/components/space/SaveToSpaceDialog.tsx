/**
 * FR-TC-02④/18 存入团队空间: turn any chat file reference into a space file
 * node without leaving the conversation — pick the destination, the main
 * process reads the bytes and uploads. Pure selection logic lives in
 * `folderChoices`; the dialog only picks and calls.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { Button } from "../ui";

export type SaveTarget = { spaceId: string; spaceName: string; folderId: string | null; folderPath: string };

export type SpaceChoice = { id: string; name: string; myPerm: string };
export type SpaceNodeLite = { id: string; name: string; type: string; parentId: string | null; perm: string };

/** Pure: flatten space trees into writable folder destinations. */
export function folderChoices(
  spaces: SpaceChoice[],
  trees: Record<string, SpaceNodeLite[]>,
): SaveTarget[] {
  const out: SaveTarget[] = [];
  for (const space of spaces) {
    if (space.myPerm === "viewer" || space.myPerm === "none") continue;
    const nodes = trees[space.id] ?? [];
    if (!nodes.length) {
      out.push({ spaceId: space.id, spaceName: space.name, folderId: null, folderPath: space.name });
      continue;
    }
    const pathOf = new Map<string, string>();
    for (const node of nodes) {
      const parent = node.parentId ? (pathOf.get(node.parentId) ?? "") : "";
      pathOf.set(node.id, parent ? `${parent}/${node.name}` : node.name);
    }
    for (const node of nodes) {
      if (node.type !== "folder") continue;
      if (node.perm === "none" || node.perm === "viewer") continue;
      out.push({
        spaceId: space.id,
        spaceName: space.name,
        folderId: node.id,
        folderPath: `${space.name}/${pathOf.get(node.id) ?? node.name}`,
      });
    }
    out.push({ spaceId: space.id, spaceName: space.name, folderId: null, folderPath: space.name });
  }
  return out;
}

export function SaveToSpaceDialog(props: {
  filePath: string;
  fileName: string;
  onClose: () => void;
  showToast: (message: string, opts?: { variant?: "success" | "error" }) => void;
}) {
  const { filePath, fileName, onClose, showToast } = props;
  const { t } = useTranslation();
  const [choices, setChoices] = useState<SaveTarget[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const spaces = (await api.listSpaces()) as SpaceChoice[];
        const trees: Record<string, SpaceNodeLite[]> = {};
        for (const space of spaces) {
          trees[space.id] = (await api.spaceTree(space.id)) as unknown as SpaceNodeLite[];
        }
        if (!cancelled) setChoices(folderChoices(spaces, trees));
      } catch {
        if (!cancelled) setChoices([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(() => choices ?? [], [choices]);

  const save = async () => {
    const target = options[selected];
    if (!target) return;
    setBusy(true);
    try {
      const result = await api.spaceSaveFromPath({
        path: filePath,
        spaceId: target.spaceId,
        parentId: target.folderId,
        name: fileName,
      });
      showToast(t("space.savedToSpace", { name: result.name ?? fileName }), { variant: "success" });
      onClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
      data-testid="save-to-space-dialog"
    >
      <div
        className="w-96 max-w-full rounded-lg border bg-[color:var(--ds-bg-elevated-opaque)] p-4"
        style={{ borderColor: "var(--ds-border-default)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 text-sm font-medium">{t("space.saveToSpaceTitle")}</div>
        <div className="mb-3 truncate text-xs opacity-60">{filePath}</div>
        {!options.length ? (
          <div className="py-3 text-center text-xs opacity-60">{t("space.noSpacesYet")}</div>
        ) : (
          <ul className="mb-3 max-h-56 overflow-auto rounded-md border" style={{ borderColor: "var(--ds-border)" }}>
            {options.map((option, index) => (
              <li key={`${option.spaceId}:${option.folderId ?? ""}:${index}`}>
                <button
                  type="button"
                  className={`w-full px-2 py-1.5 text-left text-xs hover:bg-black/5 ${index === selected ? "bg-black/10" : ""}`}
                  onClick={() => setSelected(index)}
                >
                  {option.folderPath}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={busy || !options.length} onClick={() => void save()}>
            {t("space.saveToSpaceGo")}
          </Button>
        </div>
      </div>
    </div>
  );
}
