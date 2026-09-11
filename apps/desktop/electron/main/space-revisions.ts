/**
 * Module 02 team spaces — revision/anchor pure helpers (T52.8/9, SPEC §3.3).
 *
 * Everything here is deliberately free of process/I/O dependencies (node
 * builtins + type-only imports only) so the renderer-agnostic anchor pipeline
 * is unit-testable straight from node --test:
 *
 *   anchor model  { kind:"text", paraIndex, textPrefix, textHash }  (SPEC §2)
 *   matching      exact (sha256 of the hinted original) → prefix fallback
 *                 → missing (锚定失效, SPEC §3.3: UI 显示「位置已变化」)
 *   serial merge  resolve all anchors on the ORIGINAL text, sort by offset,
 *   (server-side  reject overlaps and unresolved anchors per-suggestion,
 *    semantics    apply back-to-front so earlier offsets stay valid)
 */

import { createHash } from "node:crypto";

import type { SpaceTextAnchor } from "@pi-desktop/shared";

/** sha256 hex of a selection — the anchor's exactness check (SPEC §2). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A text anchor keeps the first PREFIX_CHARS chars as the tolerant hint. */
export const PREFIX_CHARS = 64;

/**
 * Build the anchor for a textarea selection. `selectionStart` is the offset
 * into `content` (HTMLTextAreaElement.selectionStart); paraIndex is the
 * 0-based line index holding the selection start. Returns null for an empty
 * selection (nothing to anchor).
 */
export function buildTextAnchor(
  content: string,
  selectedText: string,
  selectionStart: number,
): SpaceTextAnchor | null {
  if (!selectedText) return null;
  const lineIndex = content
    .slice(0, Math.max(0, Math.min(selectionStart, content.length)))
    .split("\n").length - 1;
  return {
    kind: "text",
    paraIndex: lineIndex,
    textPrefix: selectedText.slice(0, PREFIX_CHARS),
    textHash: sha256Hex(selectedText),
  };
}

export type AnchorMatch =
  | { status: "exact" | "prefix"; start: number; end: number }
  | { status: "missing" };

/**
 * Resolve a text anchor against current content (SPEC §2 解析规则):
 *  1. locate the paraIndex line-block;
 *  2. exact: find the hinted original inside the block and confirm its
 *     sha256 equals textHash;
 *  3. tolerant: fall back to a textPrefix match inside the block;
 *  4. both fail → 锚定失效 (missing).
 *
 * `hint` is the anchored original text when the caller still has it
 * (suggestion.originalText / the comment's captured selection). Without a
 * hint only the prefix rule can match.
 */
export function matchTextAnchor(
  content: string,
  anchor: SpaceTextAnchor,
  hint?: string,
): AnchorMatch {
  if (anchor.kind !== "text") return { status: "missing" };
  const lines = content.split("\n");
  const paraIndex = Math.max(0, Math.min(anchor.paraIndex, lines.length - 1));
  const para = lines[paraIndex] ?? "";
  const paraStart = lines
    .slice(0, paraIndex)
    .reduce((sum, line) => sum + line.length + 1, 0);

  if (hint) {
    let from = 0;
    while (from <= para.length - hint.length) {
      const at = para.indexOf(hint, from);
      if (at === -1) break;
      if (sha256Hex(hint) === anchor.textHash) {
        return {
          status: "exact",
          start: paraStart + at,
          end: paraStart + at + hint.length,
        };
      }
      from = at + 1;
    }
  }

  if (anchor.textPrefix) {
    const at = para.indexOf(anchor.textPrefix);
    if (at !== -1) {
      return {
        status: "prefix",
        start: paraStart + at,
        end: paraStart + at + anchor.textPrefix.length,
      };
    }
  }

  return { status: "missing" };
}

export interface SerialInput {
  id: string;
  anchor: SpaceTextAnchor | null;
  originalText: string;
  revisedText: string;
}

export interface SerialConflict {
  id: string;
  reason: "missing" | "overlap";
}

export interface SerialResult {
  content: string;
  applied: string[];
  conflicts: SerialConflict[];
}

/**
 * Serial merge of several suggestions into one text (the client-side twin of
 * the server's accept transaction, SPEC §3.3): anchors resolve against the
 * ORIGINAL content; unresolved anchors and pairwise-overlapping ranges are
 * per-suggestion conflicts while the rest still applies; survivors are
 * applied back-to-front so earlier offsets never shift.
 */
export function applySuggestionsSerial(
  content: string,
  suggestions: SerialInput[],
): SerialResult {
  type Resolved = {
    id: string;
    start: number;
    end: number;
    revisedText: string;
  };
  const resolved: Resolved[] = [];
  const conflicts: SerialConflict[] = [];

  for (const suggestion of suggestions) {
    if (!suggestion.anchor || suggestion.anchor.kind !== "text") {
      conflicts.push({ id: suggestion.id, reason: "missing" });
      continue;
    }
    const match = matchTextAnchor(
      content,
      suggestion.anchor,
      suggestion.originalText,
    );
    if (match.status === "missing") {
      conflicts.push({ id: suggestion.id, reason: "missing" });
      continue;
    }
    resolved.push({
      id: suggestion.id,
      start: match.start,
      end: match.end,
      revisedText: suggestion.revisedText,
    });
  }

  resolved.sort((a, b) => a.start - b.start || a.end - b.end);
  const accepted: Resolved[] = [];
  for (const candidate of resolved) {
    const last = accepted[accepted.length - 1];
    if (last && candidate.start < last.end) {
      conflicts.push({ id: candidate.id, reason: "overlap" });
      continue;
    }
    accepted.push(candidate);
  }

  let next = content;
  for (const item of accepted.slice().reverse()) {
    next = next.slice(0, item.start) + item.revisedText + next.slice(item.end);
  }
  return {
    content: next,
    applied: accepted.map((item) => item.id),
    conflicts,
  };
}

export type DiffRowType = "same" | "add" | "del";

export interface DiffRow {
  type: DiffRowType;
  text: string;
}

const DIFF_MAX_LINES = 2000;

/**
 * Minimal LCS line diff for the 原文/改后 review card. Above the cap both
 * sides render as a coarse del+add pair — the card is a human-readable
 * preview, not a patch format.
 */
export function lineDiff(original: string, revised: string): DiffRow[] {
  const a = original.length === 0 ? [] : original.split("\n");
  const b = revised.length === 0 ? [] : revised.split("\n");
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    return [
      ...a.map((text): DiffRow => ({ type: "del", text })),
      ...b.map((text): DiffRow => ({ type: "add", text })),
    ];
  }

  // LCS length table (rows: a, cols: b).
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ type: "del", text: a[i]! });
      i++;
    } else {
      rows.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) rows.push({ type: "del", text: a[i++]! });
  while (j < b.length) rows.push({ type: "add", text: b[j++]! });
  return rows;
}
