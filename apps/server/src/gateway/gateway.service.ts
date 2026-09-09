import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { providerChannels, usageLogs, users, quotaPolicies, quotaCounters, virtualKeys } from '../db/schema.js';
import { effectiveLimits, firstViolation, periodKey, resetAfterSeconds, type QuotaPolicyLike } from '../quota/quota-rules.js';
import { QuotaError } from './quota-error.js';

/**
 * T2.4 Model Gateway (SPEC §5.3) + T2.5 counter half.
 * Pipeline per call: vkey authn → quota pre-check → route upstream (health
 * first) → stream pass-through → meter to usage_logs + quota_counters.
 * Content is NEVER persisted — only metadata.
 */

export interface UpstreamFetch {
  /** injectable for tests: performs the actual upstream HTTP call */
  (url: string, init: RequestInit): Promise<Response>;
}

export interface GatewayDeps {
  db: NodePgDatabase<Record<string, never>>;
  upstreamFetch?: UpstreamFetch;
  now?: () => Date;
}

export interface ResolveChannelInput {
  model: string;
  teamId: string | null;
}

export class GatewayService {
  private readonly fetchImpl: UpstreamFetch;
  private readonly now: () => Date;

  constructor(private readonly deps: GatewayDeps) {
    this.fetchImpl = deps.upstreamFetch ?? ((u, i) => fetch(u, i));
    this.now = deps.now ?? (() => new Date());
  }

  // ---------- authn ----------

  /** Virtual key → user (+team). Revoked/unknown keys reject. */
  async authenticate(vkey: string): Promise<{ userId: string; role: string; teamId: string | null }> {
    const tokenHash = createHash('sha256').update(vkey).digest('hex');
    const key = (
      await this.deps.db
        .select()
        .from(virtualKeys)
        .where(and(eq(virtualKeys.tokenHash, tokenHash), isNull(virtualKeys.revokedAt)))
        .limit(1)
    )[0];
    if (!key) throw new QuotaError(401, 'EKEY', '虚拟 Key 无效或已吊销');
    const user = (
      await this.deps.db.select().from(users).where(eq(users.id, key.userId)).limit(1)
    )[0];
    if (!user || user.disabledAt) throw new QuotaError(401, 'EKEY', '账户不可用');
    return { userId: user.id, role: user.role, teamId: user.teamId };
  }

  // ---------- routing ----------

  /** Route by model among enabled channels assignable to the user's team; health first. */
  async route(model: string, teamId: string | null): Promise<{
    channelId: string;
    protocol: string;
    baseUrl: string;
    apiKey: string;
  }> {
    const channels = (await this.deps.db.select().from(providerChannels)) as Array<{
      id: string; protocol: string; baseUrl: string; apiKeyEnc: string; models: unknown; assign: unknown; health: string;
    }>;
    const usable = channels
      .filter((c) => (c.models as string[]).some((m) => (typeof m === 'string' ? m === model : (m as { id?: string }).id === model)))
      .filter((c) => {
        const assign = c.assign as { mode?: string; ids?: string[] };
        if (!assign || assign.mode === 'all') return true;
        if (!teamId) return false;
        return (assign.ids ?? []).includes(teamId);
      })
      .sort((a, b) => (a.health === 'ok' ? -1 : 1) - (b.health === 'ok' ? -1 : 1));
    const chosen = usable[0];
    if (!chosen) throw new QuotaError(404, 'ENOMODEL', `无可用上游渠道提供模型 ${model}`);
    // api_key_enc: P2 首版为 base64 占位加密层（密钥不出服务端；KMS 接入为后续）
    const apiKey = Buffer.from(chosen.apiKeyEnc, 'base64').toString('utf8');
    return { channelId: chosen.id, protocol: chosen.protocol, baseUrl: chosen.baseUrl, apiKey };
  }

  // ---------- quota pre-check (T2.5 IO half) ----------

  /** Pre-check BEFORE proxying: any violated (kind × period) → 429 + Reset-After. */
  async preCheckQuota(userId: string, teamId: string | null): Promise<void> {
    const policies = (await this.deps.db.select().from(quotaPolicies)) as unknown as QuotaPolicyLike[];
    if (policies.length === 0 || !teamId) {
      // 无策略或无团队归属 → 不限（BYOM 个人 Key 不占组织配额）
      if (policies.length === 0) return;
    }
    const limits = effectiveLimits(policies, { teamId: teamId ?? '', userId });
    if (limits.length === 0) return;
    const now = this.now();
    for (const l of limits) {
      const key = periodKey(l.period, now);
      const counter = (
        await this.deps.db
          .select()
          .from(quotaCounters)
          .where(
            and(
              eq(quotaCounters.subjectType, 'team'),
              eq(quotaCounters.subjectId, teamId ?? ''),
              eq(quotaCounters.periodKind, l.period),
              eq(quotaCounters.periodKey, key),
            ),
          )
          .limit(1)
      )[0];
      const used = counter
        ? l.kind === 'sessions'
          ? counter.sessions
          : Number(counter.tokensIn) + Number(counter.tokensOut)
        : 0;
      const violation = firstViolation([l], { sessions: counter?.sessions ?? 0, tokensIn: Number(counter?.tokensIn ?? 0), tokensOut: Number(counter?.tokensOut ?? 0) });
      if (violation && used >= l.limit) {
        throw new QuotaError(429, 'EQUOTA', `配额已用尽（${l.kind}/${l.period}），将于重置后恢复`, {
          'Reset-After': String(resetAfterSeconds(l.period, now)),
          'X-Quota-Limit': String(l.limit),
          'X-Quota-Used': String(used),
        });
      }
    }
  }

  // ---------- metering ----------

  /** Atomic counter increment (UPSERT … RETURNING) + usage_logs row. */
  async meter(input: {
    userId: string;
    teamId: string | null;
    channelId: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    status: number;
    sessions?: number;
  }): Promise<void> {
    const now = this.now();
    await this.deps.db.insert(usageLogs).values({
      userId: input.userId,
      teamId: input.teamId,
      channelId: input.channelId,
      model: input.model,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      latencyMs: input.latencyMs,
      status: input.status,
    });
    if (!input.teamId) return; // 个人渠道不占组织配额
    for (const period of ['daily', 'weekly', 'monthly'] as const) {
      const key = periodKey(period, now);
      await this.deps.db
        .insert(quotaCounters)
        .values({
          subjectType: 'team',
          subjectId: input.teamId,
          periodKind: period,
          periodKey: key,
          sessions: input.sessions ?? 0,
          tokensIn: input.tokensIn,
          tokensOut: input.tokensOut,
        })
        .onConflictDoUpdate({
          target: [quotaCounters.subjectType, quotaCounters.subjectId, quotaCounters.periodKind, quotaCounters.periodKey],
          set: {
            sessions: sql`${quotaCounters.sessions} + ${input.sessions ?? 0}`,
            tokensIn: sql`${quotaCounters.tokensIn} + ${input.tokensIn}`,
            tokensOut: sql`${quotaCounters.tokensOut} + ${input.tokensOut}`,
            updatedAt: now,
          },
        });
    }
  }

  /** Proxy one non-streaming request: route → upstream → meter. Returns upstream body. */
  async proxy(body: { model: string; messages?: unknown[]; stream?: boolean }, vkey: string, protocol: 'openai' | 'anthropic'): Promise<{
    status: number;
    body: Record<string, unknown>;
    usage: { tokensIn: number; tokensOut: number };
  }> {
    const auth = await this.authenticate(vkey);
    await this.preCheckQuota(auth.userId, auth.teamId);
    const channel = await this.route(body.model, auth.teamId);
    const t0 = Date.now();
    const url = protocol === 'openai' ? `${channel.baseUrl}/chat/completions` : `${channel.baseUrl}/v1/messages`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (protocol === 'openai') headers.authorization = `Bearer ${channel.apiKey}`;
    else headers['x-api-key'] = channel.apiKey;
    const upstream = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const latency = Date.now() - t0;
    const payload = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    // meter from the protocol's usage field (ADR-6: 服务端解析为准)
    const usage = extractUsage(protocol, payload);
    await this.meter({
      userId: auth.userId,
      teamId: auth.teamId,
      channelId: channel.channelId,
      model: body.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      latencyMs: latency,
      status: upstream.status,
    });
    return { status: upstream.status, body: payload, usage };
  }
}

function extractUsage(protocol: 'openai' | 'anthropic', payload: Record<string, unknown>): { tokensIn: number; tokensOut: number } {
  if (protocol === 'openai') {
    const u = payload.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    return { tokensIn: u?.prompt_tokens ?? 0, tokensOut: u?.completion_tokens ?? 0 };
  }
  const u = payload.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  return { tokensIn: u?.input_tokens ?? 0, tokensOut: u?.output_tokens ?? 0 };
}
