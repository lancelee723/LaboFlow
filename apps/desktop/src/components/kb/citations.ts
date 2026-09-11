/**
 * Renderer-side handling for the knowledge-base citation contract (module 05,
 * FR-KB-04): when a KB retrieval tool ran, the assistant reply contains
 * `[引用:n]` markers (n = 1-based result index). The stored message content is
 * never rewritten — markers are transformed at render time into small
 * superscript-style badges.
 */

/** Href prefix used by the rendered citation badges (single-page no-op). */
export const CITATION_HREF_PREFIX = "kb-citation-";

/** Complete markers only — a partially streamed `[引用:` must not match. */
const CITATION_MARKER_RE = /\[引用:(\d+)\]/g;

const FENCE_LINE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** One parsed piece of an assistant reply. */
export type CitationSegment =
  | { kind: "text"; text: string }
  | { kind: "citation"; text: string; n: number };

/**
 * Split source text into plain-text and citation segments. Only complete
 * `[引用:n]` markers become citations, so streaming renders the still-partial
 * prefix as plain text without crashing or flickering.
 */
export function parseCitationSegments(source: string): CitationSegment[] {
  if (!source.includes("[引用:")) {
    return source ? [{ kind: "text", text: source }] : [];
  }
  const segments: CitationSegment[] = [];
  let cursor = 0;
  for (const match of source.matchAll(CITATION_MARKER_RE)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ kind: "text", text: source.slice(cursor, start) });
    }
    segments.push({
      kind: "citation",
      text: match[0],
      n: Number(match[1]),
    });
    cursor = start + match[0].length;
  }
  if (cursor < source.length) {
    segments.push({ kind: "text", text: source.slice(cursor) });
  }
  return segments;
}

/** Transform one line outside code spans. */
function transformLine(line: string, makeHref: (n: number) => string): string {
  if (!line.includes("[引用:")) return line;
  // Split around backtick runs: odd indexes are inline-code delimiters, so
  // even-index chunks are prose. Code spans keep their literal marker text.
  const parts = line.split(/(`+)/);
  let inCodeSpan = false;
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        inCodeSpan = !inCodeSpan;
        return part;
      }
      if (inCodeSpan) return part;
      return part.replace(CITATION_MARKER_RE, (_marker, digits: string) => {
        const n = Number(digits);
        return `[[${n}]](${makeHref(n)})`;
      });
    })
    .join("");
}

/**
 * Rewrite complete `[引用:n]` markers into markdown links whose href carries
 * the citation index (`[[n]](#kb-citation-n)`). The Markdown pipeline styles
 * them as superscript badges via the href attribute selector, keeps them
 * clickable (no-op), and the host component adds the localized title.
 *
 * Fenced code blocks and inline code spans are skipped so example snippets
 * keep their literal `[引用:n]` text. Partially streamed markers don't match
 * and stay plain text until the closing bracket arrives.
 */
export function buildCitationSource(
  source: string,
  makeHref: (n: number) => string,
): string {
  if (!source.includes("[引用:")) return source;
  const lines = source.split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const fenceMatch = FENCE_LINE_RE.exec(lines[i]);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    lines[i] = transformLine(lines[i], makeHref);
  }
  return lines.join("\n");
}

/** Message kinds posted by the expert/team runners for module 01 cards. */
export type KbCardKind = "expert-card" | "team-card";

/** Narrow an arbitrary UiMessage `kind` to a known card kind. */
export function kbCardKind(kind: unknown): KbCardKind | null {
  return kind === "expert-card" || kind === "team-card" ? kind : null;
}
