export type KeyValuePair = { key: string; value: string };

/** Drops blank rows and collapses duplicates, last write winning. */
export function pairsToRecord(pairs: readonly KeyValuePair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    out[key] = pair.value;
  }
  return out;
}

export function recordToPairs(record: Record<string, string> | undefined): KeyValuePair[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
}
