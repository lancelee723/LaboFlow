/**
 * FR-KB-14: retrieval-usage visibility. Every KB retrieval tool call (the
 * fork's `kb-` prefixed MCP servers) is metered per local day — call counts
 * plus the house four-chars-per-token estimate for arguments and results —
 * into the settings blob (`kbUsage`), so the usage page can show a KB
 * dimension without extending the host's usage schema. The ledger rolls:
 * 90 days of history, then the oldest day falls off.
 *
 * Pure accumulation lives here; host.ts feeds calls in, the usage page reads
 * the blob back through `kbUsageHistory`.
 */

export interface KbUsageDayEntry {
  calls: number;
  /** Failed calls, already counted in `calls`. */
  errors: number;
  argumentTokens: number;
  resultTokens: number;
  totalTokens: number;
  byServer: Record<string, { calls: number; totalTokens: number }>;
}

export interface KbUsageLedger {
  version: 1;
  days: Record<string, KbUsageDayEntry>;
}

export const KB_USAGE_SETTINGS_KEY = "kbUsage";
export const KB_USAGE_MAX_DAYS = 90;

const EMPTY_DAY: KbUsageDayEntry = {
  calls: 0,
  errors: 0,
  argumentTokens: 0,
  resultTokens: 0,
  totalTokens: 0,
  byServer: {},
};

/** The fork registers retrieval services with a `kb-` prefixed server id
 * (org deliveries and personal MCP registrations through the KB path), which
 * makes `mcp_kb-…` tool names an exact gate — but the name is NOT parseable
 * into the id (ids may contain underscores), so callers pass the id they got
 * from the tool registry. */
export function isKbToolName(fullName: string): boolean {
  return fullName.startsWith("mcp_kb-");
}

export function isKbServerId(serverId: string | undefined): serverId is string {
  return typeof serverId === "string" && serverId.startsWith("kb-");
}

/** The house heuristic (context-usage.ts, runtime estimate): 4 chars/token. */
export function estimateKbTokens(args: unknown, result: unknown): {
  argumentTokens: number;
  resultTokens: number;
  totalTokens: number;
} {
  const argumentTokens = Math.ceil(jsonLength(args) / 4);
  const resultTokens = Math.ceil(jsonLength(result) / 4);
  return { argumentTokens, resultTokens, totalTokens: argumentTokens + resultTokens };
}

function jsonLength(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function localDayKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Fold one tool call into the ledger (pure; callers persist the result). */
export function recordKbToolCall(
  ledger: KbUsageLedger | undefined,
  input: {
    serverId: string;
    ok: boolean;
    args: unknown;
    result: unknown;
    now?: Date;
  },
): KbUsageLedger {
  if (!isKbServerId(input.serverId)) {
    return ledger ?? { version: 1, days: {} };
  }
  const serverId = input.serverId;
  const day = localDayKey(input.now ?? new Date());
  const next: KbUsageLedger = {
    version: 1,
    days: { ...(ledger?.days ?? {}) },
  };
  const entry: KbUsageDayEntry = { ...EMPTY_DAY, ...next.days[day] };
  entry.byServer = { ...entry.byServer };
  const estimate = estimateKbTokens(input.args, input.result);
  const previous = entry.byServer[serverId];
  entry.byServer[serverId] = {
    calls: (previous?.calls ?? 0) + 1,
    totalTokens: (previous?.totalTokens ?? 0) + estimate.totalTokens,
  };
  entry.calls += 1;
  if (!input.ok) entry.errors += 1;
  entry.argumentTokens += estimate.argumentTokens;
  entry.resultTokens += estimate.resultTokens;
  entry.totalTokens += estimate.totalTokens;
  next.days[day] = entry;
  return rollKbLedger(next, input.now ?? new Date());
}

/** Keep the most recent KB_USAGE_MAX_DAYS local days. */
export function rollKbLedger(ledger: KbUsageLedger, now: Date): KbUsageLedger {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (KB_USAGE_MAX_DAYS - 1));
  const cutoffKey = localDayKey(cutoff);
  const days = Object.fromEntries(
    Object.entries(ledger.days).filter(([key]) => key >= cutoffKey),
  );
  return { version: 1, days };
}

/** Wire shape for the usage page: newest day first. */
export function kbUsageHistory(ledger: KbUsageLedger | undefined | null): Array<{
  date: string;
  calls: number;
  errors: number;
  totalTokens: number;
  byServer: Record<string, { calls: number; totalTokens: number }>;
}> {
  if (!ledger || ledger.version !== 1) return [];
  return Object.entries(ledger.days)
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, entry]) => ({
      date,
      calls: entry.calls,
      errors: entry.errors,
      totalTokens: entry.totalTokens,
      byServer: entry.byServer,
    }));
}

export interface KbUsageMeter {
  /** No-op unless the tool belongs to a KB retrieval server. */
  record(input: {
    fullName: string;
    serverId?: string;
    ok: boolean;
    args: unknown;
    result: unknown;
  }): void;
  /** Persist pending state now (used by tests and by quit hooks). */
  flush(): Promise<void>;
}

export function createKbUsageMeter(deps: {
  load(): Promise<KbUsageLedger | undefined>;
  save(ledger: KbUsageLedger): Promise<void>;
  warn?(message: string): void;
}): KbUsageMeter {
  const FLUSH_DELAY_MS = 2_000;
  let ledger: KbUsageLedger | undefined;
  let loaded = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Records serialize: two tool calls landing together must not each load a
  // stale ledger and overwrite the other's fold.
  let queue: Promise<void> = Promise.resolve();

  const flush = async () => {
    timer = undefined;
    if (!dirty || !ledger) return;
    dirty = false;
    try {
      await deps.save(ledger);
    } catch (error) {
      deps.warn?.(String(error));
    }
  };

  return {
    record(input) {
      if (!isKbToolName(input.fullName)) return;
      queue = queue
        .then(async () => {
          if (!loaded) {
            ledger = await deps.load();
            loaded = true;
          }
          ledger = recordKbToolCall(ledger, {
            serverId: input.serverId ?? "",
            ok: input.ok,
            args: input.args,
            result: input.result,
          });
          dirty = true;
          if (!timer) timer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
          timer.unref?.();
        })
        .catch((error) => {
          deps.warn?.(String(error));
        });
    },
    flush: () => {
      if (timer) clearTimeout(timer);
      return queue.then(flush);
    },
  };
}
