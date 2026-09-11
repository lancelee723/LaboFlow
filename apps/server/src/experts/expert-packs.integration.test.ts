import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { bootstrap } from '../app.controller.js';
import { INestApplication } from '@nestjs/common';

/**
 * Module 01 组织专家库 (T51.8, FR-E-18/19) acceptance:
 * - RBAC：member 403（发布/列表/删除全禁）；sys_admin/team_admin 可发布（镜像 kb.manage）
 * - 发布幂等（SPEC §3.4 蓝本=org_skills）：同名同内容 → 版本不变；
 *   内容变化 → version+1；并发首发同名 → 单行、版本 1
 * - 校验：kind/body/members/leaderStyle/integration 422；成员 >6 拒绝
 * - bootstrap expertPacks[]：仅 enabled、{kind,name,payload,version}；
 *   DELETE 后不再下发；审计 expertPack.publish/delete 齐全
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://pptmaster:pptmaster_dev@127.0.0.1:5992/laboflow_p5_experts';
let app: INestApplication;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deps: any;
let baseUrl = '';
let pgUp = false;

let adminToken = '';
let teamAdminToken = '';
let memberAToken = '';

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json'; // 空 body 带 json content-type 会被 Fastify 400 拒掉
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

const expertPayload = (body = '战略视角系统提示词', extra: Record<string, unknown> = {}) => ({ body, ...extra });
const teamPayload = (members = ['战略规划分析师', '数据分析专家'], extra: Record<string, unknown> = {}) => ({
  members, leaderStyle: 'fine', integration: 'moderator', body: '团长拆解+整合指令模板', ...extra,
});

beforeAll(async () => {
  // 探活连维护库 postgres（laboflow_p5_experts 本身由下面这段自建，避免首跑 chicken-and-egg）
  const adminUrl = DATABASE_URL.replace(/\/[^/]+$/, '/postgres');
  try {
    const probe = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 3000 });
    await probe.query('SELECT 1');
    await probe.end();
    pgUp = true;
  } catch {
    console.warn('[skip] postgres unavailable — expert packs suite skipped');
    return;
  }
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query('DROP DATABASE IF EXISTS laboflow_p5_experts').catch(() => undefined);
  await admin.query('CREATE DATABASE laboflow_p5_experts').catch(() => undefined);
  await admin.end();

  const boot = await bootstrap({ databaseUrl: DATABASE_URL, jwtSecret: 'x'.repeat(40) });
  app = boot.app;
  deps = boot.deps;
  baseUrl = `http://127.0.0.1:${boot.port}`;

  const { hash } = await import('@node-rs/argon2');
  const { users } = await import('../db/schema.js');
  await deps.db.insert(users).values({ username: 'root', displayName: '超管', passwordHash: await hash('AdminPass123'), mustChangePassword: false, role: 'sys_admin' });
  await deps.db.insert(users).values({ username: 'ta', displayName: '团队管理', passwordHash: await hash('TeamAdmin123'), mustChangePassword: false, role: 'team_admin' });
  await deps.db.insert(users).values({ username: 'memberA', displayName: '成员A', passwordHash: await hash('MemberPass123'), mustChangePassword: false, role: 'member' });

  const login = async (username: string) =>
    ((await api('POST', '/auth/login', { username, password: username === 'root' ? 'AdminPass123' : username === 'ta' ? 'TeamAdmin123' : 'MemberPass123' })).json as unknown as { tokens: { accessToken: string } }).tokens.accessToken;
  adminToken = await login('root');
  teamAdminToken = await login('ta');
  memberAToken = await login('memberA');
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('Module 01 expert packs — RBAC (FR-E-18, mirror kb.manage)', () => {
  it('member cannot publish/list/delete (403 on all verbs)', async () => {
    if (!pgUp) return;
    expect((await api('POST', '/org/expert-packs', { kind: 'expert', name: 'x', payload: expertPayload() }, memberAToken)).status).toBe(403);
    expect((await api('GET', '/org/expert-packs', undefined, memberAToken)).status).toBe(403);
    expect((await api('DELETE', '/org/expert-packs/00000000-0000-0000-0000-000000000000', undefined, memberAToken)).status).toBe(403);
  });

  it('sys_admin and team_admin can publish; version starts at 1', async () => {
    if (!pgUp) return;
    const r1 = await api('POST', '/org/expert-packs', {
      kind: 'expert', name: '战略规划分析师', description: '行业与市场结构分析',
      payload: expertPayload('战略视角', { industry: '战略与组织', tags: ['市场测算', '竞争分析'], budgetTokens: 200000 }),
    }, adminToken);
    expect(r1.status).toBe(200);
    expect((r1.json as { version: number }).version).toBe(1);

    const r2 = await api('POST', '/org/expert-packs', {
      kind: 'team', name: '咨询交付团', description: '研究+数据+Slide 完整交付',
      payload: teamPayload(),
    }, teamAdminToken);
    expect(r2.status).toBe(200);
    expect((r2.json as { version: number }).version).toBe(1);
  });
});

describe('Module 01 expert packs — publish idempotency (SPEC §3.4)', () => {
  it('same payload republished → version unchanged', async () => {
    if (!pgUp) return;
    const payload = expertPayload('幂等正文', { industry: '金融', tags: ['尽调'] });
    const first = await api('POST', '/org/expert-packs', { kind: 'expert', name: '尽调专家', payload }, adminToken);
    expect(first.status).toBe(200);
    expect((first.json as { version: number }).version).toBe(1);
    const second = await api('POST', '/org/expert-packs', { kind: 'expert', name: '尽调专家', payload }, adminToken);
    expect(second.status).toBe(200);
    expect((second.json as { version: number }).version).toBe(1); // 内容未变不 bump
    // 键序不同也算同内容（canonical 比较）
    const reordered = await api('POST', '/org/expert-packs', {
      kind: 'expert', name: '尽调专家', payload: { tags: ['尽调'], industry: '金融', body: '幂等正文' },
    }, adminToken);
    expect((reordered.json as { version: number }).version).toBe(1);
  });

  it('changed payload republished → version +1 each time', async () => {
    if (!pgUp) return;
    await api('POST', '/org/expert-packs', { kind: 'expert', name: '行业扫描师', payload: expertPayload('v1 正文') }, adminToken);
    const v2 = await api('POST', '/org/expert-packs', { kind: 'expert', name: '行业扫描师', payload: expertPayload('v2 正文') }, adminToken);
    expect((v2.json as { version: number }).version).toBe(2);
    const v3 = await api('POST', '/org/expert-packs', { kind: 'expert', name: '行业扫描师', payload: expertPayload('v2 正文', { tags: ['竞对扫描'] }) }, adminToken);
    expect((v3.json as { version: number }).version).toBe(3);
  });

  it('validation: bad kind / empty body / team rules → 422', async () => {
    if (!pgUp) return;
    expect((await api('POST', '/org/expert-packs', { kind: 'agent', name: 'x', payload: expertPayload() }, adminToken)).status).toBe(422);
    expect((await api('POST', '/org/expert-packs', { kind: 'expert', name: 'x', payload: { body: '' } }, adminToken)).status).toBe(422);
    expect((await api('POST', '/org/expert-packs', { kind: 'expert', name: 'x', payload: {} }, adminToken)).status).toBe(422);
    expect((await api('POST', '/org/expert-packs', { kind: 'expert', name: 'x', payload: expertPayload('b', { thinkingLevel: 'ultra' }) }, adminToken)).status).toBe(422);
    expect((await api('POST', '/org/expert-packs', { kind: 'team', name: 'x', payload: { leaderStyle: 'fine', integration: 'moderator', body: 'b' } }, adminToken)).status).toBe(422);
    expect((await api('POST', '/org/expert-packs', { kind: 'team', name: 'x', payload: teamPayload(['a'], { leaderStyle: 'lazy' }) }, adminToken)).status).toBe(422);
    expect((await api('POST', '/org/expert-packs', { kind: 'team', name: 'x', payload: teamPayload(['a'], { integration: 'shout' }) }, adminToken)).status).toBe(422);
    expect((await api('POST', '/org/expert-packs', { kind: 'team', name: 'x', payload: teamPayload(['1', '2', '3', '4', '5', '6', '7']) }, adminToken)).status).toBe(422); // FR-E-14 ≤6
  });

  it('concurrent first publish of the same name → single row, no double version', async () => {
    if (!pgUp) return;
    const payload = expertPayload('并发正文', { industry: 'TMT' });
    const [a, b] = await Promise.all([
      api('POST', '/org/expert-packs', { kind: 'expert', name: '并发专家', payload }, adminToken),
      api('POST', '/org/expert-packs', { kind: 'expert', name: '并发专家', payload }, teamAdminToken),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const list = (await api('GET', '/org/expert-packs', undefined, adminToken)).json as unknown as Array<{ name: string; version: number }>;
    const rows = list.filter((r) => r.name === '并发专家');
    expect(rows.length).toBe(1); // UNIQUE(org_id,name) 兜底
    expect(rows[0]!.version).toBe(1); // 同内容：首发+幂等重发布，不叠加
  });
});

describe('Module 01 expert packs — bootstrap delivery (FR-E-18)', () => {
  let expertPackId = '';
  const teamPackName = '交付加速团';

  beforeAll(async () => {
    if (!pgUp) return;
    const created = await api('POST', '/org/expert-packs', {
      kind: 'expert', name: 'Slide 制作师', description: '组织版 Slide 专家',
      payload: expertPayload('Slide 系统提示词', { industry: '通用', tags: ['排版'], skills: ['company-slide-spec'], mcpServers: ['weknora'] }),
    }, adminToken);
    expertPackId = (created.json as { id: string }).id;
    await api('POST', '/org/expert-packs', { kind: 'team', name: teamPackName, payload: teamPayload(['Slide 制作师'], { leaderStyle: 'coarse', integration: 'sections' }) }, adminToken);
    // 停用包：无 PATCH 路由（T51.8 面），经 DB 直接置 enabled=false 验证不下发
    const disabled = await api('POST', '/org/expert-packs', { kind: 'expert', name: '下线专家', payload: expertPayload('不该下发') }, adminToken);
    const { orgExpertPacks } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    await deps.db.update(orgExpertPacks).set({ enabled: false }).where(eq(orgExpertPacks.id, (disabled.json as { id: string }).id));
  });

  it('member bootstrap lists enabled packs as {kind, name, payload, version}; disabled omitted', async () => {
    if (!pgUp) return;
    const r = await api('GET', '/org/bootstrap', undefined, memberAToken);
    expect(r.status).toBe(200);
    const packs = r.json.expertPacks as Array<{ kind: string; name: string; payload: Record<string, unknown>; version: number }>;
    const expert = packs.find((p) => p.name === 'Slide 制作师')!;
    expect(expert.kind).toBe('expert');
    expect(expert.version).toBe(1);
    expect(expert.payload.body).toBe('Slide 系统提示词');
    expect(expert.payload.skills).toEqual(['company-slide-spec']); // 名称引用随包下发
    const team = packs.find((p) => p.name === teamPackName)!;
    expect(team.kind).toBe('team');
    expect(team.payload.members).toEqual(['Slide 制作师']);
    expect(team.payload.leaderStyle).toBe('coarse');
    expect(team.payload.integration).toBe('sections');
    expect(packs.find((p) => p.name === '下线专家')).toBeUndefined(); // 停用不下发
  });

  it('delete removes from bootstrap; unknown id → 404', async () => {
    if (!pgUp) return;
    expect((await api('DELETE', `/org/expert-packs/${expertPackId}`, undefined, adminToken)).status).toBe(200);
    const packs = ((await api('GET', '/org/bootstrap', undefined, memberAToken)).json.expertPacks as Array<{ name: string }>).map((p) => p.name);
    expect(packs).not.toContain('Slide 制作师');
    expect(packs).toContain(teamPackName); // 其余仍在
    expect((await api('DELETE', '/org/expert-packs/00000000-0000-0000-0000-000000000000', undefined, adminToken)).status).toBe(404);
  });

  it('admin list shows all packs with current versions; publish/delete emit audit events', async () => {
    if (!pgUp) return;
    const list = (await api('GET', '/org/expert-packs', undefined, adminToken)).json as unknown as Array<{ name: string; version: number; enabled: boolean }>;
    expect(list.find((r) => r.name === '行业扫描师')?.version).toBe(3);
    expect(list.find((r) => r.name === '下线专家')?.enabled).toBe(false); // 全量含停用
    expect(list.find((r) => r.name === 'Slide 制作师')).toBeUndefined(); // 已删

    const audit = (await api('GET', '/admin/audit?limit=300', undefined, adminToken)).json as unknown as Array<{ action: string }>;
    const actions = audit.map((a) => a.action);
    expect(actions).toContain('expertPack.publish');
    expect(actions).toContain('expertPack.delete');
  });
});
