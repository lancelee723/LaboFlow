/**
 * Turn settlement registry (T53.1) — LaboFlow fork capability re-mounted on the
 * upstream plan runtime. Upstream `plans.ts` owns the durable turn lifecycle and
 * reports each settled turn through the `onTurnSettled` hook; this module keeps
 * the outcome long enough for the headless agent driver to consume it once.
 */
import type { TurnEndReason } from "../runtime/session-coordination";

export type TurnSettlement = {
  status: TurnEndReason;
  errorCode?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
};

const MAX_SETTLEMENTS = 200;

export function createTurnSettlementRegistry() {
  const results = new Map<string, TurnSettlement>();
  const waiters = new Map<string, Set<() => void>>();
  /** sessionId -> turnId of the most recent wait, so the driver's fallback
   * `finishTurn` call (which carries no turn id) can target the same turn. */
  const lastWaitTurn = new Map<string, string>();

  const keyOf = (sessionId: string, turnId: string) => `${sessionId}:${turnId}`;

  function recordTurnSettlement(
    sessionId: string,
    turnId: string,
    settlement: TurnSettlement,
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null,
  ): void {
    results.set(keyOf(sessionId, turnId), {
      status: settlement.status,
      errorCode: settlement.errorCode,
      usage:
        usage &&
        typeof usage.inputTokens === "number" &&
        typeof usage.outputTokens === "number"
          ? {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens ?? 0,
            }
          : undefined,
    });
    if (results.size > MAX_SETTLEMENTS) {
      const oldest = results.keys().next().value;
      if (oldest !== undefined) results.delete(oldest);
    }
    const key = keyOf(sessionId, turnId);
    const pending = waiters.get(key);
    if (pending) {
      waiters.delete(key);
      for (const resolve of pending) resolve();
    }
  }

  function waitForTurnSettlement(sessionId: string, turnId: string): Promise<void> {
    lastWaitTurn.set(sessionId, turnId);
    const key = keyOf(sessionId, turnId);
    if (results.has(key)) return Promise.resolve();
    return new Promise((resolve) => {
      const set = waiters.get(key) ?? new Set<() => void>();
      set.add(resolve);
      waiters.set(key, set);
    });
  }

  function consumeTurnSettlement(sessionId: string, turnId: string): TurnSettlement | undefined {
    const key = keyOf(sessionId, turnId);
    const value = results.get(key);
    if (value) results.delete(key);
    return value;
  }

  /** The turn id a driver last waited on for this session (fallback closes it). */
  function lastWaitedTurnId(sessionId: string): string | undefined {
    return lastWaitTurn.get(sessionId);
  }

  return { recordTurnSettlement, waitForTurnSettlement, consumeTurnSettlement, lastWaitedTurnId };
}

export type TurnSettlementRegistry = ReturnType<typeof createTurnSettlementRegistry>;
