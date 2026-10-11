import { existsSync } from "node:fs";
import { join } from "node:path";

/** Permission + declaration + entry check for a plugin opening its OWN
 * contributed view (mirrors the pluginViewOpen IPC handler semantics). */
export type OwnViewResolution =
  | { ok: true; viewId: string; htmlPath: string }
  | { ok: false; error: string; code: "PERMISSION" | "UNKNOWN_VIEW" | "ENTRY_MISSING" };

export function resolveOwnPluginView(input: {
  permissions: ReadonlySet<string>;
  views: ReadonlyArray<{ id?: unknown; entry?: unknown }>;
  pluginPath: string;
  viewId: string;
}): OwnViewResolution {
  if (!input.permissions.has("ui.view")) {
    return { ok: false, error: "PERMISSION_DENIED: ui.view", code: "PERMISSION" };
  }
  const view = input.views.find((candidate) => candidate?.id === input.viewId);
  if (!view || typeof view.entry !== "string") {
    return { ok: false, error: "plugin has no such view", code: "UNKNOWN_VIEW" };
  }
  const htmlPath = join(input.pluginPath, view.entry);
  if (!existsSync(htmlPath)) {
    return { ok: false, error: "view entry missing", code: "ENTRY_MISSING" };
  }
  return { ok: true, viewId: input.viewId, htmlPath };
}
