import type { FsDocumentKind } from "./types/filesystem.js";
/**
 * Document formats the app previews in-app (Files tab). One canonical list so
 * the host runtime, the renderer hook that routes chat file links, and the
 * bundled file-manager plugin agree on what is a previewable document.
 *
 * Legacy OLE formats (.doc/.ppt/.xls) are intentionally absent: there is no
 * browser-side renderer for them, so they keep the binary treatment.
 */
export const DOCUMENT_PREVIEW_EXTENSIONS = ["pdf", "docx", "pptx", "xlsx"] as const;

export const DOCUMENT_PREVIEW_MIME: Record<FsDocumentKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const EXTENSION_SET = new Set<string>(DOCUMENT_PREVIEW_EXTENSIONS);

/** True when the path's extension is an in-app previewable document format. */
export function isDocumentPreviewPath(path: string | null | undefined): boolean {
  const base = String(path ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return EXTENSION_SET.has(base.slice(dot + 1).toLowerCase());
}
