import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { bootstrap } from '../app.controller.js';
import { INestApplication } from '@nestjs/common';

/**
 * T2.9 admin console API + T2.10 org bootstrap acceptance:
 * - admin endpoints are sys_admin-only (403 matrix)
 * - overview aggregates reflect seeded data
 * - org/bootstrap delivers the full login pack: org/me/workspaces/
 *   orgChannels (team-scoped assignment honored)/gateway virtual key/
 *   policyFloor/orgSkills — the T2.10 client contract
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://pptmaster:pptmaster_dev@127.0.0.1:5992/laboflow_p2_admin';
let app: INestApplication;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deps: any;
let baseUrl = '';
let pgUp = false;

let adminToken = '';
let memberToken = '';
let teamId = '';
let channelId = '';

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

beforeAll(async () => {
  try {
    const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
    await probe.query('SELECT 1');
    await probe.end();
    pgUp = true;
  } catch {
    console.warn('[skip] postgres unavailable — admin/bootstrap suite skipped');
    return;
  }
  const admin = new Pool({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') });
  await admin.query('DROP DATABASE IF EXISTS laboflow_p2_admin').catch(() => undefined);
  await admin.query('CREATE DATABASE laboflow_p2_admin').catch(() => undefined);
  await admin.end();

  const boot = await bootstrap({ databaseUrl: DATABASE_URL, jwtSecret: 'x'.repeat(40) });
  app = boot.app;
  deps = boot.deps;
  baseUrl = `http://127.0.0.1:${boot.port}`;

  const { hash } = await import('@node-rs/argon2');
  const { teams, users } = await import('../db/schema.js');
  const [team] = await deps.db.insert(teams).values({ name: '管理台团队' }).returning();
  teamId = team.id;
  await deps.db.insert(users).values({ username: 'root', displayName: '超管', passwordHash: await hash('AdminPass123'), mustChangePassword: false, role: 'sys_admin' });
  await deps.db.insert(users).values({ username: 'memberA', displayName: '成员A', passwordHash: await hash('MemberPass123'), mustChangePassword: false, role: 'member', teamId });
  const [memberB] = await deps.db.insert(users).values({ username: 'memberB', displayName: '成员B', passwordHash: await hash('MemberPass123'), mustChangePassword: false, role: 'member', teamId }).returning();

  adminToken = ((await api('POST', '/auth/login', { username: 'root', password: 'AdminPass123' })).json as unknown as { tokens: { accessToken: string } }).tokens.accessToken;
  memberToken = ((await api('POST', '/auth/login', { username: 'memberA', password: 'MemberPass123' })).json as unknown as { tokens: { accessToken: string } }).tokens.accessToken;
  void memberB;

  // channel assigned to this team only + a workspace membership + quota policy + org skill
  await api('POST', '/gateway/channels', { name: 'team-channel', protocol: 'openai', baseUrl: 'http://up', apiKey: 'sk', models: ['glm-4.7'] }, adminToken);
  channelId = ((await deps.db.select((await import('../db/schema.js')).providerChannels))[0] as { id: string }).id;
  await deps.db.update((await import('../db/schema.js')).providerChannels).set({ assign: { mode: 'teams', ids: [teamId] } }).where((await import('drizzle-orm')).eq((await import('../db/schema.js')).providerChannels.id, channelId));
  const ws = await api('POST', '/workspaces', { teamId, name: '管理台工作区' }, adminToken);
  await deps.db.insert((await import('../db/schema.js')).workspaceMembers).values({ workspaceId: ws.json.id, userId: (await deps.db.select(users))[1].id, perm: 'contributor' });
  await api('PUT', '/quota/policies', { scope: 'system', kind: 'tokens', limitValue: 5_000_000, period: 'monthly' }, adminToken);
  await api('POST', '/library/skills', { name: 'slide-spec', version: '1.0.0', manifest: {}, packageBase64: 'cGtn' }, adminToken);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('T2.9 admin API', () => {
  it('member is 403 on every admin endpoint', async () => {
    if (!pgUp) return;
    for (const path of ['/admin/overview', '/admin/users', '/admin/teams', '/admin/workspaces', '/admin/channels', '/admin/quota/policies', '/admin/audit']) {
      expect((await api('GET', path, undefined, memberToken)).status).toBe(403);
    }
  });

  it('overview aggregates seeded data', async () => {
    if (!pgUp) return;
    const r = await api('GET', '/admin/overview', undefined, adminToken);
    expect(r.status).toBe(200);
    expect(Number(r.json.users)).toBeGreaterThanOrEqual(3);
    expect(Number(r.json.teams)).toBeGreaterThanOrEqual(1);
    expect(Number(r.json.workspaces)).toBeGreaterThanOrEqual(1);
    expect((r.json.usage7d as { activeUsers: number }).activeUsers).toBe(0); // no traffic yet
  });

  it('user disable/enable round-trip + disabled user cannot login', async () => {
    if (!pgUp) return;
    const users = (await api('GET', '/admin/users', undefined, adminToken)).json as unknown as Array<{ id: string; username: string; disabledAt: string | null }>;
    const target = users.find((u) => u.username === 'memberB')!;
    expect(target.disabledAt).toBeNull();
    await api('POST', `/admin/users/${target.id}/disable`, { disabled: true }, adminToken);
    const relogin = await api('POST', '/auth/login', { username: 'memberB', password: 'MemberPass123' });
    expect(relogin.status).toBe(401);
    await api('POST', `/admin/users/${target.id}/disable`, { disabled: false }, adminToken);
    const after = (await api('POST', '/auth/login', { username: 'memberB', password: 'MemberPass123' })).status;
    expect(after).toBe(200);
  });

  it('audit query returns recent security events', async () => {
    if (!pgUp) return;
    const r = await api('GET', '/admin/audit?limit=50', undefined, adminToken);
    const actions = (r.json as unknown as Array<{ action: string }>).map((a) => a.action);
    expect(actions).toContain('login.ok');
    expect(actions).toContain('library.publish');
  });
});

describe('T2.10 /org/bootstrap delivery pack', () => {
  it('delivers org/me/workspaces/channels(team-scoped)/gateway vkey/policyFloor/skills', async () => {
    if (!pgUp) return;
    const r = await api('GET', '/org/bootstrap', undefined, memberToken);
    expect(r.status).toBe(200);
    expect((r.json.me as { username: string }).username).toBe('memberA');
    expect((r.json.org as { teamId: string }).teamId).toBe(teamId);
    expect((r.json.workspaces as unknown[]).length).toBeGreaterThanOrEqual(1);
    // team-scoped channel reaches the member
    const channels = r.json.orgChannels as Array<{ name: string }>;
    expect(channels.map((c) => c.name)).toContain('team-channel');
    // virtual key works against the gateway
    const vkey = (r.json.gateway as { virtualKey: string }).virtualKey;
    expect(vkey.startsWith('vk_')).toBe(true);
    // policy floor delivered
    expect((r.json.policyFloor as unknown[]).length).toBeGreaterThanOrEqual(1);
    // org skills catalog embedded
    expect((r.json.orgSkills as Array<{ name: string }>)[0]?.name).toBe('slide-spec');
  });

  it('issued virtual key authenticates on the gateway', async () => {
    if (!pgUp) return;
    const r = await api('GET', '/org/bootstrap', undefined, memberToken);
    const vkey = (r.json.gateway as { virtualKey: string }).virtualKey;
    // call gateway with an unknown model → passes auth (404 routing, NOT 401)
    const probe = await api('POST', '/gateway/openai/v1/chat/completions', { model: 'no-such' }, vkey);
    expect(probe.status).toBe(404);
  });
});
