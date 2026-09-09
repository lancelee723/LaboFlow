import { describe, it, expect } from 'vitest';
import {
  effectiveLimits,
  firstViolation,
  periodKey,
  resetAfterSeconds,
  validateTeamPolicy,
  type QuotaPolicyLike,
} from './quota-rules.js';

const P = (over: Partial<QuotaPolicyLike>): QuotaPolicyLike => ({
  scope: 'system',
  subject: 'team',
  kind: 'tokens',
  limitValue: 1_000_000,
  period: 'monthly',
  ...over,
});

describe('quota-rules (T2.5 pure logic)', () => {
  describe('effectiveLimits 取严合并', () => {
    it('system global + system-team + team policies → strictest per (kind × period)', () => {
      const policies: QuotaPolicyLike[] = [
        P({ scope: 'system', kind: 'tokens', period: 'monthly', limitValue: 5_000_000 }),
        P({ scope: 'system', teamId: 't1', kind: 'tokens', period: 'monthly', limitValue: 3_000_000 }),
        P({ scope: 'team', teamId: 't1', kind: 'tokens', period: 'monthly', limitValue: 2_000_000 }),
        P({ scope: 'system', kind: 'sessions', period: 'daily', limitValue: 200 }),
        P({ scope: 'team', teamId: 't1', kind: 'sessions', period: 'daily', limitValue: 100 }),
      ];
      const limits = effectiveLimits(policies, { teamId: 't1', userId: 'u1' });
      expect(limits).toContainEqual({ kind: 'tokens', period: 'monthly', limit: 2_000_000 });
      expect(limits).toContainEqual({ kind: 'sessions', period: 'daily', limit: 100 });
    });

    it("ignores other teams' policies and system policies scoped to other teams", () => {
      const policies: QuotaPolicyLike[] = [
        P({ scope: 'system', teamId: 't2', kind: 'tokens', period: 'monthly', limitValue: 1 }),
        P({ scope: 'team', teamId: 't2', kind: 'tokens', period: 'monthly', limitValue: 1 }),
        P({ scope: 'system', kind: 'tokens', period: 'monthly', limitValue: 9_000_000 }),
      ];
      const limits = effectiveLimits(policies, { teamId: 't1', userId: 'u1' });
      expect(limits).toEqual([{ kind: 'tokens', period: 'monthly', limit: 9_000_000 }]);
    });

    it('empty policies → no limits (BYOM 不限)', () => {
      expect(effectiveLimits([], { teamId: 't1', userId: 'u1' })).toEqual([]);
    });
  });

  describe('firstViolation 先触及先生效', () => {
    it('sessions violation', () => {
      const v = firstViolation([{ kind: 'sessions', period: 'daily', limit: 200 }], {
        sessions: 200, tokensIn: 0, tokensOut: 0,
      });
      expect(v?.kind).toBe('sessions');
    });
    it('tokens violation (in + out combined)', () => {
      const v = firstViolation([{ kind: 'tokens', period: 'monthly', limit: 1000 }], {
        sessions: 1, tokensIn: 700, tokensOut: 300,
      });
      expect(v?.used).toBe(1000);
    });
    it('no violation when under all limits', () => {
      expect(
        firstViolation(
          [
            { kind: 'sessions', period: 'daily', limit: 200 },
            { kind: 'tokens', period: 'monthly', limit: 5_000_000 },
          ],
          { sessions: 199, tokensIn: 1000, tokensOut: 1000 },
        ),
      ).toBeNull();
    });
  });

  describe('periodKey 自然日历', () => {
    it('daily/monthly formats', () => {
      expect(periodKey('daily', new Date(2026, 8, 6))).toBe('2026-09-06');
      expect(periodKey('monthly', new Date(2026, 8, 6))).toBe('2026-09');
    });
    it('weekly ISO key (2026-09-06 is Sunday → belongs to W36 by ISO Monday rule)', () => {
      const key = periodKey('weekly', new Date(2026, 8, 6));
      expect(key).toMatch(/^2026-W\d{2}$/);
    });
  });

  describe('resetAfterSeconds', () => {
    it('daily resets at midnight', () => {
      const s = resetAfterSeconds('daily', new Date(2026, 8, 6, 23, 0, 0));
      expect(s).toBe(3600);
    });
    it('monthly resets at next month start', () => {
      const s = resetAfterSeconds('monthly', new Date(2026, 8, 30, 12, 0, 0));
      expect(s).toBe(12 * 3600); // Sep 30 12:00 → Oct 1 00:00
    });
  });

  describe('validateTeamPolicy 团队级不得宽于系统级', () => {
    it('rejects looser team policy', () => {
      const v = validateTeamPolicy(P({ scope: 'team', limitValue: 6_000_000 }), [
        P({ scope: 'system', limitValue: 5_000_000 }),
      ]);
      expect(v.ok).toBe(false);
      expect(v.reason).toContain('不得宽于系统级');
    });
    it('accepts equal or stricter', () => {
      expect(validateTeamPolicy(P({ scope: 'team', limitValue: 5_000_000 }), [P({ scope: 'system', limitValue: 5_000_000 })]).ok).toBe(true);
      expect(validateTeamPolicy(P({ scope: 'team', limitValue: 100 }), [P({ scope: 'system', limitValue: 5_000_000 })]).ok).toBe(true);
    });
    it('different kind/period has no conflict', () => {
      expect(validateTeamPolicy(P({ scope: 'team', kind: 'sessions', period: 'daily', limitValue: 999 }), [P({ scope: 'system', kind: 'tokens', limitValue: 5 })]).ok).toBe(true);
    });
  });
});
