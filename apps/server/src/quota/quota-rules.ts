/**
 * T2.5 quota engine — pure decision logic (no IO). The IO half (atomic
 * counter upserts, policy storage) lives in QuotaService; these functions are
 * the 取严合并 (strictest-wins) rules that PRD 4.2.4 fixes and the period-key
 * calendar math. Fully unit-tested.
 */

export type QuotaKind = 'sessions' | 'tokens';
export type QuotaPeriod = 'daily' | 'weekly' | 'monthly';
export type QuotaScope = 'system' | 'team';
export type QuotaSubject = 'team' | 'user';

export interface QuotaPolicyLike {
  id?: string;
  scope: QuotaScope;
  teamId?: string | null;
  subject: QuotaSubject;
  subjectId?: string | null;
  kind: QuotaKind;
  limitValue: number;
  period: QuotaPeriod;
}

export interface CountersLike {
  sessions: number;
  tokensIn: number;
  tokensOut: number;
}

/** Server-timezone natural calendar key (PRD 4.2.4: 周期按服务器时区自然日历). */
export function periodKey(period: QuotaPeriod, now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  switch (period) {
    case 'daily':
      return `${y}-${m}-${d}`;
    case 'monthly':
      return `${y}-${m}`;
    case 'weekly': {
      // ISO week key, e.g. 2026-W36
      const date = new Date(Date.UTC(y, now.getMonth(), now.getDate()));
      const dayNum = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
      return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    }
  }
}
/**
 * Exclusive end boundary of the period containing `now` (server timezone),
 * exposed by the remaining API as the client-visible reset time.
 */
export function periodEnd(period: QuotaPeriod, now: Date): Date {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  switch (period) {
    case 'daily':
      return new Date(y, m, d + 1);
    case 'weekly': {
      const day = now.getDay() || 7; // Mon=1..Sun=7
      return new Date(y, m, d + (8 - day));
    }
    case 'monthly':
      return new Date(y, m + 1, 1);
  }
}


/**
 * Effective limit per (kind × period): STRICTEST WINS.
 * Applicable set = system policies (global or this team) ∪ this team's own
 * policies. Team policies can never be looser than system (API also rejects,
 * defense in depth here).
 */
export function effectiveLimits(
  policies: QuotaPolicyLike[],
  ctx: { teamId: string; userId: string },
): Array<{ kind: QuotaKind; period: QuotaPeriod; limit: number }> {
  const applicable = policies.filter((p) => {
    if (p.scope === 'system') {
      // system-global or system-scoped-to-this-team
      return !p.teamId || p.teamId === ctx.teamId;
    }
    // team-level policies only count for members of that team
    return p.teamId === ctx.teamId;
  });
  const out = new Map<string, { kind: QuotaKind; period: QuotaPeriod; limit: number }>();
  for (const p of applicable) {
    const key = `${p.kind}:${p.period}`;
    const prev = out.get(key);
    if (!prev || p.limitValue < prev.limit) {
      out.set(key, { kind: p.kind, period: p.period, limit: p.limitValue });
    }
  }
  return [...out.values()];
}

export interface QuotaCheckInput {
  limits: Array<{ kind: QuotaKind; period: QuotaPeriod; limit: number }>;
  counters: CountersLike; // aggregated over each period by the caller? No — caller passes per-period counters
}

/**
 * Pre-check: FIRST LIMIT TOUCHED WINS (任一触顶即限制). Returns the violated
 * constraint or null. The caller evaluates per period-key with that period's
 * counters.
 */
export function firstViolation(
  limits: Array<{ kind: QuotaKind; period: QuotaPeriod; limit: number }>,
  counters: CountersLike,
): { kind: QuotaKind; period: QuotaPeriod; limit: number; used: number } | null {
  for (const l of limits) {
    const used = l.kind === 'sessions' ? counters.sessions : counters.tokensIn + counters.tokensOut;
    if (used >= l.limit) {
      return { ...l, used };
    }
  }
  return null;
}

/** Validate a team-level policy against system policies (不得宽于系统级). */
export function validateTeamPolicy(
  candidate: QuotaPolicyLike,
  systemPolicies: QuotaPolicyLike[],
): { ok: boolean; reason?: string } {
  if (candidate.scope !== 'team') return { ok: true };
  if (candidate.limitValue <= 0) return { ok: false, reason: 'limit must be positive' };
  const conflicting = systemPolicies.filter(
    (s) => s.scope === 'system' && s.kind === candidate.kind && s.period === candidate.period,
  );
  for (const s of conflicting) {
    if (candidate.limitValue > s.limitValue) {
      return { ok: false, reason: `团队级不得宽于系统级（${candidate.kind}/${candidate.period}: 系统 ${s.limitValue}）` };
    }
  }
  return { ok: true };
}

/** Reset-after seconds until the period rolls over (for the 429 body). */
export function resetAfterSeconds(period: QuotaPeriod, now: Date): number {
  const next = new Date(now);
  switch (period) {
    case 'daily':
      next.setHours(24, 0, 0, 0);
      break;
    case 'weekly': {
      const day = now.getDay() || 7; // Mon=1..Sun=7
      next.setDate(next.getDate() + (8 - day));
      next.setHours(0, 0, 0, 0);
      break;
    }
    case 'monthly':
      next.setMonth(next.getMonth() + 1, 1);
      next.setHours(0, 0, 0, 0);
      break;
  }
  return Math.max(1, Math.round((next.getTime() - now.getTime()) / 1000));
}
