// Live-preview exit watching (遗留 B — Exit-preview guidance): the SVG
// editor's Exit-preview button stops the flask server, which releases
// live_preview/lock.json. The plugin watches for that release while a
// preview it started is up, then (a) feeds the workbench status line and
// (b) injects the live-preview Stage 2 "apply annotations" continuation via
// session.continueFromPlugin. Pure helpers live here so the poll state
// machine and the status window are unit-testable without timers or files.

import { join } from "node:path";

/** How long the workbench status line keeps showing "preview closed" after
 * the server exits — after this window the pipeline's own states take the
 * line back (the annotation apply has either happened or is a lost cause). */
export const PREVIEW_CLOSED_STATUS_WINDOW_MS = 10 * 60_000;

/** How long the exit watcher may poll for lock.json before giving up: a
 * preview that never reports a lock (daemon died at boot) is not ours to
 * watch forever. */
export const PREVIEW_WATCH_MAX_MS = 4 * 60 * 60_000;

export function lockFilePath(projectDir) {
  return join(projectDir, "live_preview", "lock.json");
}

export function annotationsLogPath(projectDir) {
  return join(projectDir, "live_preview", "annotations.jsonl");
}

/** Saved-annotation evidence: records land on every Apply changes (and the
 * agent appends annotation_applied records when it works through them), so
 * any non-empty line means annotations were saved at least once. */
export function countAnnotationRecords(jsonlText) {
  if (typeof jsonlText !== "string") return 0;
  return jsonlText.split("\n").filter((line) => line.trim().length > 0).length;
}

/** Pure view of one watched preview for the panel.
 * entry: { startedAtMs, sawLock, closedAtMs, annotationsSaved } | null */
export function previewStatusFor(entry, nowMs) {
  if (!entry) {
    return { watched: false, active: false, closedRecently: false, annotationsSaved: false };
  }
  const active = Boolean(entry.sawLock) && !entry.closedAtMs;
  const closedRecently =
    Boolean(entry.closedAtMs) && nowMs - entry.closedAtMs <= PREVIEW_CLOSED_STATUS_WINDOW_MS;
  return { watched: true, active, closedRecently, annotationsSaved: entry.annotationsSaved === true };
}
