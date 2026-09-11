import { useLayoutEffect, useMemo, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "../Markdown";
import { buildCitationSource, CITATION_HREF_PREFIX } from "./citations";
import "./kb.css";

const citationAnchorSelector = `a[href^="#${CITATION_HREF_PREFIX}"]`;

function citationIndexFromHref(href: string): number | null {
  if (!href.startsWith(`#${CITATION_HREF_PREFIX}`)) return null;
  const n = Number(href.slice(1 + CITATION_HREF_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Assistant-answer markdown with knowledge-base citation markers rendered as
 * superscript badges (FR-KB-04). The stored content is untouched: complete
 * `[引用:n]` markers become no-op badge links at render time, partial markers
 * stay plain text while streaming, and the localized tooltip is applied after
 * mount (the sanitizer strips markdown link titles).
 */
export function CitationMarkdown({ source }: { source: string }) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const transformed = useMemo(
    () => buildCitationSource(source, (n) => `#${CITATION_HREF_PREFIX}${n}`),
    [source],
  );

  // The sanitizer only keeps href on anchors, so the tooltip text is attached
  // directly to the rendered badge nodes. Streaming recreates them as the tail
  // block re-parses; re-running on every content change keeps titles in step.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !transformed.includes(CITATION_HREF_PREFIX)) return;
    for (const anchor of host.querySelectorAll<HTMLAnchorElement>(
      citationAnchorSelector,
    )) {
      const n = citationIndexFromHref(anchor.getAttribute("href") ?? "");
      if (n !== null) {
        anchor.setAttribute("title", t("kb.citationTitle", { n }));
        anchor.setAttribute("data-kb-citation", String(n));
      }
    }
  }, [transformed, t]);

  // Clickable no-op for v1: swallow the click so the fragment href doesn't
  // scroll the transcript; opening the referenced source lands with the
  // structured citation card work later.
  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.(citationAnchorSelector)) event.preventDefault();
  };

  return (
    <div ref={hostRef} className="kb-citation-host" onClick={onClick}>
      <Markdown source={transformed} />
    </div>
  );
}
