import type { KbUrlEntry } from "@pi-desktop/shared";

/**
 * What the 知识库 sidebar entry should do with the current KB URL list
 * (FR-KB-06): nothing configured → toast; exactly one → open it directly;
 * several → show the picker.
 */
export type KbEntryDecision =
  | { action: "empty" }
  | { action: "open"; url: string }
  | { action: "pick" };

export function decideKbEntry(urls: readonly KbUrlEntry[]): KbEntryDecision {
  if (!urls?.length) return { action: "empty" };
  const first = urls[0];
  if (urls.length === 1 && first?.url) return { action: "open", url: first.url };
  return { action: "pick" };
}
