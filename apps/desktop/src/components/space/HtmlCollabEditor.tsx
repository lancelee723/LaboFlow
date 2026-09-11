import { useTranslation } from "react-i18next";
import type { SpaceNode } from "@pi-desktop/shared";
import { IconCode } from "../icons";

/**
 * HTML collab editor placeholder. The server slice exposes no HTML content
 * surface yet (space_docs covers md/csv only) and the Yjs CRDT provider is
 * batch D (T52.12/13) — FR-TC-12/13 deep work is intentionally out of this
 * slice. Routing exists so the tree already handles html nodes.
 */
export function HtmlCollabEditor(props: { node: SpaceNode }) {
  const { node } = props;
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed p-6 text-center" style={{ borderColor: "var(--ds-border-strong)" }}>
      <IconCode size={22} />
      <span className="text-sm font-medium">{node.name}</span>
      <span className="max-w-md text-xs opacity-60">{t("space.html.placeholder")}</span>
    </div>
  );
}
