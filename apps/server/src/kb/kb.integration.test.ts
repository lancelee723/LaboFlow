import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { bootstrap } from '../app.controller.js';
import { INestApplication } from '@nestjs/common';

/**
 * Module 05 知识库下发 (FR-KB-02/10/11) acceptance:
 * - RBAC：member 403（增删改查全禁）；team_admin/sys_admin 可建（镜像 org-skills）
 * - apiKey 静态加密（AES-256-GCM，密文落库）+ 列表打码（尾 4 位）
 * - bootstrap kbServers[]：scope=all 全员、scope=teams 仅命中团队、
 *   停用不下发、mcp 项交付明文 key（TLS 下）、web 项仅 name/url
 * - 重名 409；PATCH 轮换 key/停用；DELETE 后不再下发；审计事件齐全
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://pptmaster:pptmaster_dev@127.0.0.1:5992/laboflow_p5_kb';
let app: INestApplication;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deps: any;
let baseUrl = '';
let pgUp = false;

let adminToken = '';
let teamAdminToken = '';
let memberAToken = ''; // 团队A成员
let memberBToken = ''; // 团队B成员
let teamAId = '';

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json'; // 空 body 带 json content-type 会被 Fastify 400 拒掉
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

beforeAll(async () => {
  // 探活连维护库 postgres（laboflow_p5_kb 本身由下面这段自建，避免首跑 chicken-and-egg）
  const adminUrl = DATABASE_URL.replace(/\/[^/]+$/, '/postgres');
  try {
    const probe = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 3000 });
    await probe.query('SELECT 1');
    await probe.end();
    pgUp = true;
  } catch {
    console.warn('[skip] postgres unavailable — kb server suite skipped');
    return;
  }
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query('DROP DATABASE IF EXISTS laboflow_p5_kb').catch(() => undefined);
  await admin.query('CREATE DATABASE laboflow_p5_kb').catch(() => undefined);
  await admin.end();

  const boot = await bootstrap({ databaseUrl: DATABASE_URL, jwtSecret: 'x'.repeat(40), serverEncryptionKey: 'kb-suite-master-key' });
  app = boot.app;
  deps = boot.deps;
  baseUrl = `http://127.0.0.1:${boot.port}`;

  const { hash } = await import('@node-rs/argon2');
  const { teams, users } = await import('../db/schema.js');
  const [teamA] = await deps.db.insert(teams).values({ name: '知识团队A' }).returning();
  const [teamB] = await deps.db.insert(teams).values({ name: '知识团队B' }).returning();
  teamAId = teamA.id;
  await deps.db.insert(users).values({ username: 'root', displayName: '超管', passwordHash: await hash('AdminPass123'), mustChangePassword: false, role: 'sys_admin' });
  await deps.db.insert(users).values({ username: 'ta', displayName: '团队A管理', passwordHash: await hash('TeamAdmin123'), mustChangePassword: false, role: 'team_admin', teamId: teamA.id });
  await deps.db.insert(users).values({ username: 'memberA', displayName: '成员A', passwordHash: await hash('MemberPass123'), mustChangePassword: false, role: 'member', teamId: teamA.id });
  await deps.db.insert(users).values({ username: 'memberB', displayName: '成员B', passwordHash: await hash('MemberPass123'), mustChangePassword: false, role: 'member', teamId: teamB.id });

  const login = async (username: string) =>
    ((await api('POST', '/auth/login', { username, password: username === 'root' ? 'AdminPass123' : username === 'ta' ? 'TeamAdmin123' : 'MemberPass123' })).json as unknown as { tokens: { accessToken: string } }).tokens.accessToken;
  adminToken = await login('root');
  teamAdminToken = await login('ta');
  memberAToken = await login('memberA');
  memberBToken = await login('memberB');
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('Module 05 KB servers — RBAC (FR-KB-02, mirror org-skills)', () => {
  it('member cannot create/list/update/delete (403)', async () => {
    if (!pgUp) return;
    expect((await api('POST', '/org/kb-servers', { kind: 'web', name: 'x', url: 'https://x' }, memberAToken)).status).toBe(403);
    expect((await api('GET', '/org/kb-servers', undefined, memberAToken)).status).toBe(403);
    expect((await api('PATCH', '/org/kb-servers/00000000-0000-0000-0000-000000000000', { enabled: false }, memberAToken)).status).toBe(403);
    expect((await api('DELETE', '/org/kb-servers/00000000-0000-0000-0000-000000000000', undefined, memberAToken)).status).toBe(403);
  });

  it('sys_admin can create an mcp item; list shows masked keyTail only', async () => {
    if (!pgUp) return;
    const created = await api('POST', '/org/kb-servers', {
      kind: 'mcp', name: 'weknora-检索', transport: 'http', url: 'https://kb.example.com/mcp',
      apiKey: 'sk-weknora-abcdef1234', description: '组织知识库检索', scope: 'all',
    }, adminToken);
    expect(created.status).toBe(200);
    expect(created.json.apiKeyEnc).toBeUndefined(); // DTO 不含密文字段

    const list = (await api('GET', '/org/kb-servers', undefined, adminToken)).json as unknown as Array<{ name: string; keyTail: string }>;
    const row = list.find((r) => r.name === 'weknora-检索')!;
    expect(row.keyTail).toBe('1234');
    const raw = JSON.stringify(list);
    expect(raw).not.toContain('sk-weknora-abcdef1234'); // 明文绝不出现在管理列表
    expect(raw).not.toContain('apiKeyEnc');
  });

  it('team_admin can create (mirror library.publish)', async () => {
    if (!pgUp) return;
    const r = await api('POST', '/org/kb-servers', { kind: 'web', name: '产品手册', url: 'https://docs.example.com' }, teamAdminToken);
    expect(r.status).toBe(200);
    expect((r.json as { kind: string }).kind).toBe('web');
  });

  it('duplicate name is rejected with 409', async () => {
    if (!pgUp) return;
    const r = await api('POST', '/org/kb-servers', { kind: 'web', name: '产品手册', url: 'https://other.example.com' }, adminToken);
    expect(r.status).toBe(409);
  });

  it('validation: bad kind / empty url / teams without teamIds → 422', async () => {
    if (!pgUp) return;
    expect((await api('POST', '/org/kb-servers', { kind: 'ftp', name: 'x', url: 'u' }, adminToken)).status).toBe(422);
    expect((await api('POST', '/org/kb-servers', { kind: 'web', name: 'x', url: '' }, adminToken)).status).toBe(422);
    expect((await api('POST', '/org/kb-servers', { kind: 'mcp', name: 'x', url: 'u', scope: 'teams', teamIds: [] }, adminToken)).status).toBe(422);
  });
});

describe('Module 05 KB servers — encryption at rest + audit', () => {
  it('apiKeyEnc is AES-256-GCM ciphertext, not plaintext/base64 of it', async () => {
    if (!pgUp) return;
    const { orgKbServers } = await import('../db/schema.js');
    const rows = (await deps.db.select().from(orgKbServers)) as Array<{ name: string; apiKeyEnc: string | null }>;
    const row = rows.find((r) => r.name === 'weknora-检索')!;
    expect(row.apiKeyEnc).toBeTruthy();
    expect(row.apiKeyEnc!).not.toContain('sk-weknora-abcdef1234');
    expect(row.apiKeyEnc!.startsWith('v1.')).toBe(true);
    expect(Buffer.from(row.apiKeyEnc!.slice(3), 'base64').toString('utf8')).not.toContain('sk-weknora'); // 非裸 base64
  });

  it('create/update/delete emit audit events (self-contained lifecycle)', async () => {
    if (!pgUp) return;
    const created = await api('POST', '/org/kb-servers', { kind: 'web', name: 'kb-audit-probe', url: 'https://audit.example.com' }, adminToken);
    expect(created.status).toBe(200);
    const id = (created.json as { id: string }).id;
    await api('PATCH', `/org/kb-servers/${id}`, { enabled: false }, adminToken);
    await api('DELETE', `/org/kb-servers/${id}`, undefined, adminToken);
    const r = await api('GET', '/admin/audit?limit=200', undefined, adminToken);
    const actions = (r.json as unknown as Array<{ action: string }>).map((a) => a.action);
    expect(actions).toContain('kb.create');
    expect(actions).toContain('kb.update');
    expect(actions).toContain('kb.delete');
  });
});

describe('Module 05 KB servers — bootstrap delivery (FR-KB-02/11)', () => {
  let kbTeamId = '';

  beforeAll(async () => {
    if (!pgUp) return;
    // 4 件套：全员 mcp / 团队A mcp / 全员 web / 停用 mcp
    await api('POST', '/org/kb-servers', {
      kind: 'mcp', name: 'kb-all', transport: 'http', url: 'https://kb.example.com/mcp',
      apiKey: 'sk-all-9999', description: '全员检索', scope: 'all',
    }, adminToken);
    const teamScoped = await api('POST', '/org/kb-servers', {
      kind: 'mcp', name: 'kb-team-a', transport: 'stdio', url: 'uvx --from tencent-weknora-mcp weknora-mcp-server',
      apiKey: 'sk-team-8888', scope: 'teams', teamIds: [teamAId],
    }, adminToken);
    kbTeamId = (teamScoped.json as { id: string }).id;
    await api('POST', '/org/kb-servers', { kind: 'web', name: 'kb-web', url: 'https://manual.example.com' }, adminToken);
    const disabled = await api('POST', '/org/kb-servers', { kind: 'mcp', name: 'kb-off', url: 'https://off.example.com/mcp', apiKey: 'sk-off' }, adminToken);
    await api('PATCH', `/org/kb-servers/${(disabled.json as { id: string }).id}`, { enabled: false }, adminToken);
  });

  it('team-A member receives all+team-scoped mcp (with plaintext apiKey over TLS) and web; not disabled', async () => {
    if (!pgUp) return;
    const r = await api('GET', '/org/bootstrap', undefined, memberAToken);
    expect(r.status).toBe(200);
    const kb = r.json.kbServers as Array<{ name: string; kind: string; apiKey?: string; url?: string; transport?: string }>;
    const all = kb.find((s) => s.name === 'kb-all')!;
    expect(all.kind).toBe('mcp');
    expect(all.apiKey).toBe('sk-all-9999'); // 交付=明文经 TLS
    expect(kb.find((s) => s.name === 'kb-team-a')).toBeTruthy();
    const web = kb.find((s) => s.name === 'kb-web')!;
    expect(web.kind).toBe('web');
    expect(web.url).toBe('https://manual.example.com');
    expect(web.apiKey).toBeUndefined();
    expect(kb.find((s) => s.name === 'kb-off')).toBeUndefined(); // 停用不下发
    expect(kb.find((s) => s.name === 'weknora-检索')).toBeTruthy(); // 早前建的 scope=all 也在
  });

  it('team-B member does NOT receive team-A scoped item', async () => {
    if (!pgUp) return;
    const kb = ((await api('GET', '/org/bootstrap', undefined, memberBToken)).json.kbServers as Array<{ name: string }>).map((s) => s.name);
    expect(kb).not.toContain('kb-team-a');
    expect(kb).toContain('kb-all'); // scope=all 仍可达
  });

  it('disable/enable round-trip controls delivery; PATCH rotates apiKey; DELETE removes', async () => {
    if (!pgUp) return;
    await api('PATCH', `/org/kb-servers/${kbTeamId}`, { enabled: false, apiKey: 'sk-team-rotated-7777' }, adminToken);
    let kb = ((await api('GET', '/org/bootstrap', undefined, memberAToken)).json.kbServers as Array<{ name: string }>).map((s) => s.name);
    expect(kb).not.toContain('kb-team-a');

    await api('PATCH', `/org/kb-servers/${kbTeamId}`, { enabled: true }, adminToken);
    kb = ((await api('GET', '/org/bootstrap', undefined, memberAToken)).json.kbServers as Array<{ name: string; apiKey?: string }>).map((s) => s.name);
    expect(kb).toContain('kb-team-a');
    // key 轮换生效（明文交付跟着换）
    const list = ((await api('GET', '/org/kb-servers', undefined, adminToken)).json as unknown as Array<{ id: string; keyTail: string }>);
    expect(list.find((r) => r.id === kbTeamId)?.keyTail).toBe('7777');

    const del = await api('DELETE', `/org/kb-servers/${kbTeamId}`, undefined, adminToken);
    expect(del.status).toBe(200);
    kb = ((await api('GET', '/org/bootstrap', undefined, memberAToken)).json.kbServers as Array<{ name: string }>).map((s) => s.name);
    expect(kb).not.toContain('kb-team-a');
    const remaining = ((await api('GET', '/org/kb-servers', undefined, adminToken)).json as unknown as Array<{ id: string }>).map((r) => r.id);
    expect(remaining).not.toContain(kbTeamId);
  });
});
