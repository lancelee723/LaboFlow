import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { bootstrap } from '../app.controller.js';
import { INestApplication } from '@nestjs/common';

/**
 * T2.4/T2.5 acceptance with an INJECTED upstream (no real network):
 * - openai + anthropic proxy pass-through with usage extraction (ADR-6)
 * - metering: usage_logs row + quota_counters atomic increment
 * - quota pre-check: tokens exhausted → 429 with Reset-After; in-flight
 *   requests never truncated (check happens at request start)
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://pptmaster:pptmaster_dev@127.0.0.1:5992/laboflow_p2_meter';
let app: INestApplication;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deps: any;
let baseUrl = '';
let pgUp = false;

let adminToken = '';
const memberToken = '';
let memberVkey = '';
let teamId = '';
let memberId = '';

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json, headers: res.headers };
}

beforeAll(async () => {
  try {
    const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
    await probe.query('SELECT 1');
    await probe.end();
    pgUp = true;
  } catch {
    console.warn('[skip] postgres unavailable — metering suite skipped');
    return;
  }
  const admin = new Pool({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') });
  await admin.query('DROP DATABASE IF EXISTS laboflow_p2_meter').catch(() => undefined);
  await admin.query('CREATE DATABASE laboflow_p2_meter').catch(() => undefined);
  await admin.end();

  // mock upstream: answers both protocols with a fixed usage block
  const boot = await bootstrap({
    databaseUrl: DATABASE_URL,
    jwtSecret: 'x'.repeat(40),
    upstreamFetch: async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model?: string };
      const isOpenai = url.includes('/chat/completions');
      const payload = isOpenai
        ? { id: 'cmpl-mock', model: body.model, choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 42 } }
        : { id: 'msg_mock', model: body.model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 42 } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  app = boot.app;
  deps = boot.deps;
  baseUrl = `http://127.0.0.1:${boot.port}`;

  // seed: admin → team → member (reuse the bootstrap auth service for hashing)
  const team = await deps.db.insert((await import('../db/schema.js')).teams).values({ name: '计量测试团队' }).returning();
  teamId = team[0]!.id;
  const { hash } = await import('@node-rs/argon2');
  await deps.db.insert((await import('../db/schema.js')).users).values({
    username: 'meter-admin', displayName: '管理员', passwordHash: await hash('AdminPass123'),
    mustChangePassword: false, role: 'sys_admin',
  });
  const member = await deps.db.insert((await import('../db/schema.js')).users).values({
    username: 'meter-member', displayName: '成员', passwordHash: await hash('MemberPass123'),
    mustChangePassword: false, role: 'member', teamId,
  }).returning();
  memberId = member[0]!.id;

  const login = await api('POST', '/auth/login', { username: 'meter-admin', password: 'AdminPass123' });
  adminToken = (login.json.tokens as { accessToken: string }).accessToken;

  await api('POST', '/gateway/channels', { name: 'mock', protocol: 'openai', baseUrl: 'http://mock-upstream', apiKey: 'sk-mock', models: ['glm-4.7', 'claude-mock'] }, adminToken);
  const vk = await deps.auth.issueVirtualKey(memberId);
  memberVkey = vk.plain;
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('gateway metering + quota (T2.4/T2.5, injected upstream)', () => {
  it('openai protocol: proxies upstream, meters usage into counters', async () => {
    if (!pgUp) return;
    const r = await api('POST', '/gateway/openai/v1/chat/completions', { model: 'glm-4.7', messages: [{ role: 'user', content: 'hi' }] }, memberVkey);
    expect(r.status).toBe(200);
    expect((r.json.usage as { completion_tokens: number }).completion_tokens).toBe(42);

    const pool = new Pool({ connectionString: DATABASE_URL });
    const counters = (await pool.query('SELECT tokens_in, tokens_out FROM quota_counters WHERE subject_type=$1 AND subject_id=$2 AND period_kind=$3', ['team', teamId, 'daily'])).rows;
    const logs = (await pool.query('SELECT model, tokens_in, tokens_out, status FROM usage_logs ORDER BY id DESC LIMIT 1')).rows;
    await pool.end();
    expect(Number(counters[0]?.tokens_in)).toBe(100);
    expect(Number(counters[0]?.tokens_out)).toBe(42);
    expect(logs[0]?.model).toBe('glm-4.7');
    expect(logs[0]?.status).toBe(200);
  });

  it('anthropic protocol: same pipeline, anthropic usage field', async () => {
    if (!pgUp) return;
    const r = await api('POST', '/gateway/anthropic/v1/messages', { model: 'claude-mock', messages: [] }, memberVkey);
    expect(r.status).toBe(200);
    expect((r.json.usage as { input_tokens: number }).input_tokens).toBe(100);
    const pool = new Pool({ connectionString: DATABASE_URL });
    const counters = (await pool.query("SELECT tokens_in FROM quota_counters WHERE period_kind='daily' AND subject_id=$1", [teamId])).rows;
    await pool.end();
    expect(Number(counters[0]?.tokens_in)).toBe(200); // 100 + 100 accumulated
  });

  it('token quota exhausted → 429 with Reset-After (先触及先生效)', async () => {
    if (!pgUp) return;
    // system policy: 250 tokens monthly — we are at 200, one more call (142) blows past
    const set = await api('PUT', '/quota/policies', { scope: 'system', kind: 'tokens', limitValue: 250, period: 'monthly' }, adminToken);
    expect(set.status).toBe(200);
    const blocked = await api('POST', '/gateway/openai/v1/chat/completions', { model: 'glm-4.7' }, memberVkey);
    expect(blocked.status).toBe(429);
    expect(blocked.json.code).toBe('EQUOTA');
    expect(blocked.headers.get('reset-after')).toBeTruthy();
    expect(Number(blocked.headers.get('x-quota-used'))).toBeGreaterThanOrEqual(250);
  });

  it('invalid virtual key → 401 even with quota available', async () => {
    if (!pgUp) return;
    const r = await api('POST', '/gateway/openai/v1/chat/completions', { model: 'glm-4.7' }, 'Bearer vk_bogus');
    expect(r.status).toBe(401);
  });

  it('unknown model → 404 无可用上游渠道', async () => {
    if (!pgUp) return;
    // member with fresh vkey (quota is per team and exhausted, so use admin's own key:
    // admin has no team → personal BYOM path skips team quota)
    const vk = await deps.auth.issueVirtualKey(
      (await deps.db.select((await import('../db/schema.js')).users)).filter((u: { username: string }) => u.username === 'meter-admin')[0].id,
    );
    const r = await api('POST', '/gateway/openai/v1/chat/completions', { model: 'nonexistent-model' }, `Bearer ${vk.plain}`);
    expect(r.status).toBe(404);
  });
});
