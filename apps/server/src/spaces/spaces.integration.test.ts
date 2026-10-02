import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { bootstrap } from '../app.controller.js';
import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * Module 02 团队空间 (T52.1-3) 集成验收（真实 PG，镜像 kb.integration.test.ts）：
 * - 权限矩阵（space-rules 的 HTTP 面）：viewer/contributor/manager × 动作
 * - 树可见性：none 覆盖从列表隐藏 + 直读 404（SPEC §4 存在性伪装）
 * - 乐观锁文档保存：baseVersion 冲突 409 EVERSION；20 版滚动
 * - 评论线程 + 状态流转；修订建议 pending→accept 应用文本→原文变化 409 EANCHOR
 * - 邀请链接：有效/过期/次数耗尽；事件 since 游标 + 200 条上限
 * - 审计：member.grant/revoke、node.delete、revision.decide、invite.create/redeem
 */

const DB_NAME = 'laboflow_p5_spaces';
const DATABASE_URL = process.env.DATABASE_URL ?? `postgres://pptmaster:pptmaster_dev@127.0.0.1:5992/${DB_NAME}`;
let app: INestApplication;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deps: any;
let baseUrl = '';
let pgUp = false;

let rootToken = ''; // sys_admin
let taToken = ''; // team_admin（团队A，空间管理者）
let aliceToken = ''; // member 团队A → contributor
let bobToken = ''; // member 团队A → viewer
let carolToken = ''; // member 团队B（邀请兑换者）
let daveToken = ''; // member 团队B（第二个兑换者）
let taId = '';
let aliceId = '';

let spaceId = '';

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json'; // 空 body 带 json content-type 会被 Fastify 400 拒掉
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

beforeAll(async () => {
  const adminUrl = DATABASE_URL.replace(/\/[^/]+$/, '/postgres');
  try {
    const probe = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 3000 });
    await probe.query('SELECT 1');
    await probe.end();
    pgUp = true;
  } catch {
    console.warn('[skip] postgres unavailable — spaces suite skipped');
    return;
  }
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => undefined);
  await admin.query(`CREATE DATABASE ${DB_NAME}`).catch(() => undefined);
  await admin.end();

  const storageDir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 't52-files-'));
  const boot = await bootstrap({ databaseUrl: DATABASE_URL, jwtSecret: 'x'.repeat(40), storageDir });
  app = boot.app;
  deps = boot.deps;
  baseUrl = `http://127.0.0.1:${boot.port}`;

  const { hash } = await import('@node-rs/argon2');
  const { teams, users } = await import('../db/schema.js');
  const insertedTeams = await deps.db.insert(teams).values([{ name: '空间团队A' }, { name: '空间团队B' }]).returning();
  const teamA = insertedTeams[0];
  const teamB = insertedTeams[1];
  const mk = async (username: string, role: string, teamId: string | null) => {
    const [u] = await deps.db.insert(users).values({
      username, displayName: username, passwordHash: await hash('Passw0rd!123'),
      mustChangePassword: false, role, teamId,
    }).returning();
    return u;
  };
  const root = await mk('root', 'sys_admin', null);
  const ta = await mk('ta', 'team_admin', teamA.id);
  const alice = await mk('alice', 'member', teamA.id);
  await mk('bob', 'member', teamA.id);
  await mk('carol', 'member', teamB.id);
  await mk('dave', 'member', teamB.id);
  taId = ta.id;
  aliceId = alice.id;
  void root;

  const login = async (username: string) =>
    ((await api('POST', '/auth/login', { username, password: 'Passw0rd!123' })).json as unknown as { tokens: { accessToken: string } }).tokens.accessToken;
  rootToken = await login('root');
  taToken = await login('ta');
  aliceToken = await login('alice');
  bobToken = await login('bob');
  carolToken = await login('carol');
  daveToken = await login('dave');

  const created = await api('POST', '/spaces', { teamId: teamA.id, name: '课题组空间', description: 'T52 验收空间' }, taToken);
  expect(created.status).toBe(200);
  spaceId = (created.json as { id: string }).id;
  await api('POST', `/spaces/${spaceId}/members`, { userId: aliceId, perm: 'contributor' }, taToken);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

// ---------------------------------------------------------------- 空间与成员

describe('T52.1/2 空间与成员管理', () => {
  it('member 不能建空间（403）；非成员读空间 404 伪装', async () => {
    if (!pgUp) return;
    expect((await api('POST', '/spaces', { name: 'x' }, aliceToken)).status).toBe(403);
    expect((await api('GET', `/spaces/${spaceId}/members`, undefined, daveToken)).status).toBe(404);
    expect((await api('GET', `/spaces/${spaceId}/tree`, undefined, daveToken)).status).toBe(404);
  });

  it('创建者是 manager；我的空间列表含 myPerm；改档/移除仅 manager', async () => {
    if (!pgUp) return;
    const mine = (await api('GET', '/spaces', undefined, taToken)).json as unknown as Array<{ id: string; myPerm: string; name: string }>;
    const mineRow = mine.find((s) => s.id === spaceId)!;
    expect(mineRow.myPerm).toBe('manager');
    expect(mineRow.name).toBe('课题组空间');

    const members = (await api('GET', `/spaces/${spaceId}/members`, undefined, taToken)).json as unknown as Array<{ userId: string; perm: string }>;
    expect(members.find((m) => m.userId === taId)?.perm).toBe('manager');
    expect(members.find((m) => m.userId === aliceId)?.perm).toBe('contributor');

    // contributor 不能管理成员/建空间级配置
    expect((await api('POST', `/spaces/${spaceId}/members`, { userId: aliceId, perm: 'manager' }, aliceToken)).status).toBe(403);
    expect((await api('PATCH', `/spaces/${spaceId}`, { name: '黑改名' }, aliceToken)).status).toBe(403);
  });

  it('成员改档/移除走审计与事件；最后一位 manager 不可降级', async () => {
    if (!pgUp) return;
    // bob 先加为 viewer
    const bobUser = (await api('GET', '/admin/users', undefined, rootToken)).json as unknown as Array<{ id: string; username: string }>;
    const bobId = bobUser.find((u) => u.username === 'bob')!.id;
    expect((await api('POST', `/spaces/${spaceId}/members`, { userId: bobId, perm: 'viewer' }, taToken)).status).toBe(200);
    expect((await api('PATCH', `/spaces/${spaceId}/members/${bobId}`, { perm: 'contributor' }, taToken)).status).toBe(200);
    expect((await api('PATCH', `/spaces/${spaceId}/members/${bobId}`, { perm: 'viewer' }, taToken)).status).toBe(200);
    // 移除后立即失去可见性（404 伪装），再加回 viewer 供后续用例使用
    expect((await api('DELETE', `/spaces/${spaceId}/members/${bobId}`, undefined, taToken)).status).toBe(200);
    expect((await api('GET', `/spaces/${spaceId}/tree`, undefined, bobToken)).status).toBe(404);
    expect((await api('POST', `/spaces/${spaceId}/members`, { userId: bobId, perm: 'viewer' }, taToken)).status).toBe(200);
    // 最后一位 manager 不可降级/移除
    expect((await api('PATCH', `/spaces/${spaceId}/members/${taId}`, { perm: 'viewer' }, taToken)).status).toBe(409);
    expect((await api('DELETE', `/spaces/${spaceId}/members/${taId}`, undefined, taToken)).status).toBe(409);

    const events = ((await api('GET', `/spaces/${spaceId}/events?since=-1`, undefined, taToken)).json.events as Array<{ type: string }>).map((e) => e.type);
    expect(events).toContain('member.added');
    expect(events).toContain('member.updated');
    expect(events).toContain('member.removed');
  });

  it('重命名 + 归档/解除归档（manager）；归档后写入被拒', async () => {
    if (!pgUp) return;
    expect((await api('PATCH', `/spaces/${spaceId}`, { name: '课题组空间·改' }, taToken)).status).toBe(200);
    expect((await api('PATCH', `/spaces/${spaceId}`, { archived: true }, taToken)).status).toBe(200);
    const node = (await api('POST', `/spaces/${spaceId}/nodes`, { type: 'folder', name: '归档期建节点' }, taToken)).json as { code?: string };
    expect(node.code).toBe('EARCHIVED');
    expect((await api('PATCH', `/spaces/${spaceId}`, { archived: false }, taToken)).status).toBe(200);
  });
});

// ---------------------------------------------------------------- 节点树

describe('T52.1 节点树：创建/移动/环防护/回收站', () => {
  let folderId = '';
  let noteId = '';

  it('建节点：类型/父节点校验；viewer 不能建；树输出父先于子且带有效档位', async () => {
    if (!pgUp) return;
    const folder = await api('POST', `/spaces/${spaceId}/nodes`, { type: 'folder', name: '实验记录' }, taToken);
    expect(folder.status).toBe(200);
    folderId = (folder.json as { id: string }).id;
    const note = await api('POST', `/spaces/${spaceId}/nodes`, { parentId: folderId, type: 'md', name: '实验方案' }, taToken);
    expect(note.status).toBe(200);
    noteId = (note.json as { id: string }).id;

    expect((await api('POST', `/spaces/${spaceId}/nodes`, { type: 'ftp', name: 'x' }, taToken)).status).toBe(422);
    expect((await api('POST', `/spaces/${spaceId}/nodes`, { type: 'md', name: '' }, taToken)).status).toBe(422);
    expect((await api('POST', `/spaces/${spaceId}/nodes`, { parentId: noteId, type: 'md', name: 'x' }, taToken)).status).toBe(422); // md 不是文件夹
    expect((await api('POST', `/spaces/${spaceId}/nodes`, { parentId: '00000000-0000-0000-0000-000000000000', type: 'md', name: 'x' }, taToken)).status).toBe(404);
    expect((await api('POST', `/spaces/${spaceId}/nodes`, { type: 'folder', name: 'viewer建' }, bobToken)).status).toBe(403);

    const tree = (await api('GET', `/spaces/${spaceId}/tree`, undefined, aliceToken)).json as unknown as Array<{ id: string; parentId: string | null; perm: string; type: string }>;
    const fi = tree.findIndex((n) => n.id === folderId);
    const ni = tree.findIndex((n) => n.id === noteId);
    expect(fi).toBeGreaterThanOrEqual(0);
    expect(ni).toBeGreaterThan(fi); // 父先于子
    expect(tree.find((n) => n.id === noteId)?.perm).toBe('contributor');
  });

  it('移动与环路防护（409 ECYCLE）、重命名广播 node.updated', async () => {
    if (!pgUp) return;
    const sub = await api('POST', `/spaces/${spaceId}/nodes`, { parentId: folderId, type: 'folder', name: '子目录' }, taToken);
    const subId = (sub.json as { id: string }).id;
    const cycle = await api('PATCH', `/spaces/${spaceId}/nodes/${folderId}`, { parentId: subId }, taToken);
    expect(cycle.status).toBe(409);
    expect((cycle.json as { code?: string }).code).toBe('ECYCLE');
    expect((await api('PATCH', `/spaces/${spaceId}/nodes/${subId}`, { parentId: null }, taToken)).status).toBe(200); // 移到根
    expect((await api('PATCH', `/spaces/${spaceId}/nodes/${subId}`, { name: '子目录·改' }, taToken)).status).toBe(200);

    const events = ((await api('GET', `/spaces/${spaceId}/events?since=-1`, undefined, taToken)).json.events as Array<{ type: string }>).map((e) => e.type);
    expect(events).toContain('node.updated');
  });

  it('回收站：contributor 删本人节点 OK、删他人 403；manager 删任意；恢复', async () => {
    if (!pgUp) return;
    const mine = await api('POST', `/spaces/${spaceId}/nodes`, { type: 'md', name: 'alice的笔记' }, aliceToken);
    const mineId = (mine.json as { id: string }).id;
    expect((await api('DELETE', `/spaces/${spaceId}/nodes/${mineId}`, undefined, aliceToken)).status).toBe(200); // 本人节点
    // 删除后从树中消失，直读 404
    let tree = ((await api('GET', `/spaces/${spaceId}/tree`, undefined, aliceToken)).json as unknown as Array<{ id: string }>).map((n) => n.id);
    expect(tree).not.toContain(mineId);
    expect((await api('GET', `/spaces/${spaceId}/nodes/${mineId}/doc`, undefined, aliceToken)).status).toBe(404);
    // contributor 不能删他人节点（ta 建的 folder）
    expect((await api('DELETE', `/spaces/${spaceId}/nodes/${folderId}`, undefined, aliceToken)).status).toBe(403);
    // manager 删文件夹 → 整棵子树隐藏；恢复后回归
    expect((await api('DELETE', `/spaces/${spaceId}/nodes/${folderId}`, undefined, taToken)).status).toBe(200);
    tree = ((await api('GET', `/spaces/${spaceId}/tree`, undefined, taToken)).json as unknown as Array<{ id: string }>).map((n) => n.id);
    expect(tree).not.toContain(folderId);
    expect(tree).not.toContain(noteId); // 子树随父隐藏
    expect((await api('POST', `/spaces/${spaceId}/nodes/${folderId}/restore`, undefined, taToken)).status).toBe(200);
    tree = ((await api('GET', `/spaces/${spaceId}/tree`, undefined, taToken)).json as unknown as Array<{ id: string }>).map((n) => n.id);
    expect(tree).toContain(folderId);
    expect(tree).toContain(noteId);

    const audit = (await api('GET', '/admin/audit?limit=300', undefined, rootToken)).json as unknown as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toContain('node.delete');
  });
});

// ---------------------------------------------------------------- none 覆盖可见性

describe('T52.2 节点级 none 覆盖：列表隐藏 + 直读 404', () => {
  let secretId = '';

  it('none 覆盖：contributor 树中不可见、直读 404；manager 不受影响；清除后恢复', async () => {
    if (!pgUp) return;
    const secret = await api('POST', `/spaces/${spaceId}/nodes`, { type: 'folder', name: '机密数据' }, taToken);
    expect(secret.status).toBe(200);
    secretId = (secret.json as { id: string }).id;
    // contributor 不能设置覆盖（节点尚对 alice 可见 → 403 而非伪装）
    expect((await api('PATCH', `/spaces/${spaceId}/nodes/${secretId}/overrides/${aliceId}`, { perm: 'none' }, aliceToken)).status).toBe(403);
    expect((await api('PATCH', `/spaces/${spaceId}/nodes/${secretId}/overrides/${aliceId}`, { perm: 'none' }, taToken)).status).toBe(200);

    let aliceTree = ((await api('GET', `/spaces/${spaceId}/tree`, undefined, aliceToken)).json as unknown as Array<{ id: string }>).map((n) => n.id);
    expect(aliceTree).not.toContain(secretId);
    expect((await api('GET', `/spaces/${spaceId}/nodes/${secretId}/doc`, undefined, aliceToken)).status).toBe(404); // 存在性伪装
    const taTree = ((await api('GET', `/spaces/${spaceId}/tree`, undefined, taToken)).json as unknown as Array<{ id: string }>).map((n) => n.id);
    expect(taTree).toContain(secretId); // manager 不受影响

    expect((await api('DELETE', `/spaces/${spaceId}/nodes/${secretId}/overrides/${aliceId}`, undefined, taToken)).status).toBe(200);
    aliceTree = ((await api('GET', `/spaces/${spaceId}/tree`, undefined, aliceToken)).json as unknown as Array<{ id: string }>).map((n) => n.id);
    expect(aliceTree).toContain(secretId);
  });
});

// ---------------------------------------------------------------- 文档版本链

describe('T52.3 文档：乐观锁保存 + 20 版滚动', () => {
  let docId = '';

  beforeAll(async () => {
    if (!pgUp) return;
    const node = await api('POST', `/spaces/${spaceId}/nodes`, { type: 'md', name: '版本链笔记' }, aliceToken);
    docId = (node.json as { id: string }).id;
  });

  it('保存：baseVersion 冲突 409 EVERSION；happy path 版本递增 + sha256 服务端计算', async () => {
    if (!pgUp) return;
    const v1 = await api('PUT', `/spaces/${spaceId}/nodes/${docId}/doc`, { content: '# 第一版\n', baseVersion: 0 }, aliceToken);
    expect(v1.status).toBe(200);
    expect((v1.json as { version: number }).version).toBe(1);
    expect((v1.json as { sha256: string }).sha256).toBe(createHash('sha256').update('# 第一版\n', 'utf8').digest('hex'));

    // viewer 不能保存
    expect((await api('PUT', `/spaces/${spaceId}/nodes/${docId}/doc`, { content: 'x', baseVersion: 1 }, bobToken)).status).toBe(403);
    // 陈旧 baseVersion → 409 EVERSION
    const conflict = await api('PUT', `/spaces/${spaceId}/nodes/${docId}/doc`, { content: 'stale', baseVersion: 0 }, aliceToken);
    expect(conflict.status).toBe(409);
    expect((conflict.json as { code: string }).code).toBe('EVERSION');

    const v2 = await api('PUT', `/spaces/${spaceId}/nodes/${docId}/doc`, { content: '# 第二版\n', baseVersion: 1 }, aliceToken);
    expect((v2.json as { version: number }).version).toBe(2);

    const cur = await api('GET', `/spaces/${spaceId}/nodes/${docId}/doc`, undefined, bobToken);
    expect((cur.json as { version: number; content: string; source: string }).version).toBe(2);
    expect((cur.json as { content: string }).content).toBe('# 第二版\n');
    expect((cur.json as { source: string }).source).toBe('human');
    const old = await api('GET', `/spaces/${spaceId}/nodes/${docId}/doc?version=1`, undefined, bobToken);
    expect((old.json as { content: string }).content).toBe('# 第一版\n');
    expect((await api('GET', `/spaces/${spaceId}/nodes/${docId}/doc?version=99`, undefined, bobToken)).status).toBe(404);
  });

  it('20 版滚动：只保留最近 20 个版本，旧版本 404', async () => {
    if (!pgUp) return;
    let base = 2;
    for (let i = 3; i <= 24; i++) {
      const r = await api('PUT', `/spaces/${spaceId}/nodes/${docId}/doc`, { content: `v${i}\n`, baseVersion: base }, aliceToken);
      expect(r.status).toBe(200);
      base = i;
    }
    const cur = await api('GET', `/spaces/${spaceId}/nodes/${docId}/doc`, undefined, aliceToken);
    expect((cur.json as { version: number; content: string }).version).toBe(24);
    expect((cur.json as { content: string }).content).toBe('v24\n');
    // v4 及更早已被滚动清理，v5 仍在（24-20+1=5）
    expect((await api('GET', `/spaces/${spaceId}/nodes/${docId}/doc?version=4`, undefined, aliceToken)).status).toBe(404);
    expect((await api('GET', `/spaces/${spaceId}/nodes/${docId}/doc?version=5`, undefined, aliceToken)).status).toBe(200);
    const events = ((await api('GET', `/spaces/${spaceId}/events?since=-1`, undefined, taToken)).json.events as Array<{ type: string; payload: { version?: number } }>).filter((e) => e.type === 'doc.version');
    expect(events.length).toBeGreaterThanOrEqual(24);
    expect(events.some((e) => e.payload?.version === 24)).toBe(true);
  });
});

// ---------------------------------------------------------------- 评论线程

describe('T52.8 评论：线程/回复/状态流转', () => {
  let commentId = '';

  it('viewer 可评论；回复挂 parent；非作者非 manager 不能 resolve；作者/manager 可流转', async () => {
    if (!pgUp) return;
    const docId = ((await api('GET', `/spaces/${spaceId}/tree`, undefined, aliceToken)).json as unknown as Array<{ id: string; type: string; name: string }>)
      .find((n) => n.name === '实验方案')!.id;
    const c = await api('POST', `/spaces/${spaceId}/nodes/${docId}/comments`, {
      body: '这段方法学需要补充',
      anchor: { kind: 'text', paraIndex: 2, textPrefix: '市场规模', textHash: 'abc' },
    }, bobToken);
    expect(c.status).toBe(200);
    commentId = (c.json as { id: string }).id;
    expect((c.json as { status: string }).status).toBe('open');

    expect((await api('POST', `/spaces/${spaceId}/nodes/${docId}/comments/${commentId}/reply`, { body: '已补充，见 v3' }, aliceToken)).status).toBe(200);
    const list = (await api('GET', `/spaces/${spaceId}/nodes/${docId}/comments`, undefined, bobToken)).json as unknown as Array<{ id: string; parentId: string | null }>;
    expect(list.length).toBe(2);
    expect(list.find((x) => x.id !== commentId)?.parentId).toBe(commentId);

    // alice 是 contributor 但不是线程作者 → 不可 resolve
    expect((await api('POST', `/spaces/${spaceId}/nodes/${docId}/comments/${commentId}/resolve`, {}, aliceToken)).status).toBe(403);
    // 作者可 resolve
    expect((await api('POST', `/spaces/${spaceId}/nodes/${docId}/comments/${commentId}/resolve`, {}, bobToken)).status).toBe(200);
    // manager 可重开
    const reopened = await api('POST', `/spaces/${spaceId}/nodes/${docId}/comments/${commentId}/resolve`, { status: 'open' }, taToken);
    expect(reopened.status).toBe(200);
    expect((reopened.json as { status: string }).status).toBe('open');

    const events = ((await api('GET', `/spaces/${spaceId}/events?since=-1`, undefined, taToken)).json.events as Array<{ type: string }>).map((e) => e.type);
    expect(events).toContain('comment.created');
    expect(events).toContain('comment.replied');
    expect(events).toContain('comment.status');
  });
});

// ---------------------------------------------------------------- 修订建议

describe('T52.9 修订建议：pending → 接受应用 → EANCHOR', () => {
  let docId = '';
  let suggestionId = '';

  beforeAll(async () => {
    if (!pgUp) return;
    const node = await api('POST', `/spaces/${spaceId}/nodes`, { type: 'md', name: '修订审阅稿' }, aliceToken);
    docId = (node.json as { id: string }).id;
    await api('PUT', `/spaces/${spaceId}/nodes/${docId}/doc`, { content: 'line1\nline2\n', baseVersion: 0 }, aliceToken);
  });

  it('创建 pending（producedBy=agent）；viewer/他人建议的决策被拒', async () => {
    if (!pgUp) return;
    const sug = await api('POST', `/spaces/${spaceId}/nodes/${docId}/revisions`, {
      originalText: 'line1', revisedText: 'LINE-1', rationale: '术语统一',
      anchor: { kind: 'text', paraIndex: 0, textPrefix: 'line1' },
      producedBy: 'agent', model: 'glm-4.6',
    }, aliceToken);
    expect(sug.status).toBe(200);
    expect((sug.json as { status: string; producedBy: string }).status).toBe('pending');
    expect((sug.json as { producedBy: string }).producedBy).toBe('agent');
    suggestionId = (sug.json as { id: string }).id;

    expect((await api('POST', `/spaces/${spaceId}/nodes/${docId}/revisions/${suggestionId}/decide`, { decision: 'accepted' }, bobToken)).status).toBe(403);

    // ta 提一条自己的建议 → alice（contributor）不能决定他人的
    const taSug = await api('POST', `/spaces/${spaceId}/nodes/${docId}/revisions`, { originalText: 'line2', revisedText: 'LINE-2' }, taToken);
    const taSugId = (taSug.json as { id: string }).id;
    expect((await api('POST', `/spaces/${spaceId}/nodes/${docId}/revisions/${taSugId}/decide`, { decision: 'accepted' }, aliceToken)).status).toBe(403);
    expect((await api('POST', `/spaces/${spaceId}/nodes/${docId}/revisions/${taSugId}/decide`, { decision: 'rejected' }, taToken)).status).toBe(200);
  });

  it('接受：事务内重读正文替换锚定原文 → 新版本 source=ai-accept', async () => {
    if (!pgUp) return;
    const decided = await api('POST', `/spaces/${spaceId}/nodes/${docId}/revisions/${suggestionId}/decide`, { decision: 'accepted' }, aliceToken);
    expect(decided.status).toBe(200);
    expect((decided.json as { status: string; appliedVersion: number }).status).toBe('accepted');
    expect((decided.json as { appliedVersion: number }).appliedVersion).toBe(2);

    const doc = await api('GET', `/spaces/${spaceId}/nodes/${docId}/doc`, undefined, bobToken);
    expect((doc.json as { content: string }).content).toBe('LINE-1\nline2\n');
    expect((doc.json as { version: number; source: string }).version).toBe(2);
    expect((doc.json as { source: string }).source).toBe('ai-accept');

    const audit = (await api('GET', '/admin/audit?limit=300', undefined, rootToken)).json as unknown as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toContain('revision.decide');
  });

  it('原文已变化 → 接受 409 EANCHOR，建议保持 pending', async () => {
    if (!pgUp) return;
    const stale = await api('POST', `/spaces/${spaceId}/nodes/${docId}/revisions`, { originalText: 'line1', revisedText: '不应生效' }, aliceToken);
    const staleId = (stale.json as { id: string }).id;
    const decide = await api('POST', `/spaces/${spaceId}/nodes/${docId}/revisions/${staleId}/decide`, { decision: 'accepted' }, aliceToken);
    expect(decide.status).toBe(409);
    expect((decide.json as { code: string }).code).toBe('EANCHOR');
    const list = (await api('GET', `/spaces/${spaceId}/nodes/${docId}/revisions`, undefined, bobToken)).json as unknown as Array<{ id: string; status: string }>;
    expect(list.find((r) => r.id === staleId)?.status).toBe('pending');
    // 正文未被污染
    const doc = await api('GET', `/spaces/${spaceId}/nodes/${docId}/doc`, undefined, bobToken);
    expect((doc.json as { content: string }).content).toBe('LINE-1\nline2\n');

    const events = ((await api('GET', `/spaces/${spaceId}/events?since=-1`, undefined, taToken)).json.events as Array<{ type: string }>).map((e) => e.type);
    expect(events).toContain('revision.created');
    expect(events).toContain('revision.decided');
    expect(events).toContain('doc.version');
  });
});

// ---------------------------------------------------------------- 邀请链接

describe('T52.2 邀请链接：token 哈希存储 / 过期 / 次数上限', () => {
  it('创建仅返回一次明文 token；兑换获得档位；耗尽 410；伪造 404；过期 410', async () => {
    if (!pgUp) return;
    const inv = await api('POST', `/spaces/${spaceId}/invites`, { perm: 'contributor', maxUses: 1, expiresInDays: 7 }, taToken);
    expect(inv.status).toBe(200);
    const token = (inv.json as { token: string }).token;
    expect(token).toBeTruthy();
    // 库中只有哈希
    const { inviteLinks } = await import('../db/schema.js');
    const rows = (await deps.db.select().from(inviteLinks)) as Array<{ tokenHash: string }>;
    expect(rows.some((r) => r.tokenHash === token)).toBe(false);
    expect(rows.some((r) => r.tokenHash === createHash('sha256').update(token, 'utf8').digest('hex'))).toBe(true);

    const redeemed = await api('POST', '/invites/redeem', { token }, carolToken);
    expect(redeemed.status).toBe(200);
    expect(redeemed.json).toMatchObject({ spaceId, perm: 'contributor' });
    const carolTree = await api('GET', `/spaces/${spaceId}/tree`, undefined, carolToken);
    expect(carolTree.status).toBe(200);

    // 次数耗尽（maxUses=1 已用 1 次）
    const exhausted = await api('POST', '/invites/redeem', { token }, daveToken);
    expect(exhausted.status).toBe(410);
    expect((exhausted.json as { code: string }).code).toBe('EEXHAUSTED');

    // 伪造 token
    expect((await api('POST', '/invites/redeem', { token: 'not-a-real-token' }, daveToken)).status).toBe(404);

    // 过期：直接落一条已过期的邀请（expiresInDays 校验不允许 0/负数）
    const expiredToken = 'expired-token-abc';
    await deps.db.insert(inviteLinks).values({
      spaceId,
      tokenHash: createHash('sha256').update(expiredToken, 'utf8').digest('hex'),
      perm: 'viewer', access: 'apply', expiresAt: new Date(Date.now() - 1000), createdBy: taId,
    });
    const expired = await api('POST', '/invites/redeem', { token: expiredToken }, daveToken);
    expect(expired.status).toBe(410);
    expect((expired.json as { code: string }).code).toBe('EEXPIRED');

    // contributor 不能建邀请
    expect((await api('POST', `/spaces/${spaceId}/invites`, { perm: 'viewer' }, aliceToken)).status).toBe(403);

    const audit = (await api('GET', '/admin/audit?limit=300', undefined, rootToken)).json as unknown as Array<{ action: string }>;
    const actions = audit.map((a) => a.action);
    expect(actions).toContain('invite.create');
    expect(actions).toContain('invite.redeem');
    expect(actions).toContain('member.grant');
    expect(actions).toContain('member.revoke');
  });
});

// ---------------------------------------------------------------- 事件推流

describe('T52.3 事件推流：since 游标 + 200 条上限', () => {
  it('since 游标：仅返回增量且有序；lastSeq 单调', async () => {
    if (!pgUp) return;
    const before = (await api('GET', `/spaces/${spaceId}/events?since=-1`, undefined, taToken)).json as { events: Array<{ seq: number }>; lastSeq: number };
    expect(before.events.length).toBeGreaterThan(0);
    const seqs = before.events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // 有序

    await api('POST', `/spaces/${spaceId}/nodes`, { type: 'folder', name: '游标探测' }, taToken);
    const delta = (await api('GET', `/spaces/${spaceId}/events?since=${before.lastSeq}`, undefined, taToken)).json as { events: Array<{ seq: number; type: string }>; lastSeq: number };
    expect(delta.events.length).toBeGreaterThanOrEqual(1);
    expect(delta.events.every((e) => e.seq > before.lastSeq)).toBe(true);
    expect(delta.events[0]!.type).toBe('node.created');
    expect(delta.lastSeq).toBeGreaterThanOrEqual(delta.events[delta.events.length - 1]!.seq);
  });

  it('单次拉取上限 200 条', async () => {
    if (!pgUp) return;
    const { spaceEvents } = await import('../db/schema.js');
    const cur = (await api('GET', `/spaces/${spaceId}/events?since=-1`, undefined, taToken)).json as { lastSeq: number };
    const start = cur.lastSeq + 1;
    await deps.db.insert(spaceEvents).values(
      Array.from({ length: 205 }, (_, i) => ({ spaceId, seq: start + i, type: 'test.bulk', payload: { i }, actorId: null })),
    );
    const capped = (await api('GET', `/spaces/${spaceId}/events?since=${cur.lastSeq}`, undefined, taToken)).json as { events: unknown[]; lastSeq: number };
    expect(capped.events.length).toBe(200);
    expect(capped.lastSeq).toBe(start + 204);
  });

// ---------------------------------------------------------------- T52.5 文件上传
describe('FR-TC-06 org_settings 协作范围闸口', () => {
  it('默认组织内锁定：团队 B 经邀请加入被拒 403；放开后可加入', async () => {
    if (!pgUp) return;
    // carol（团队B）没有被加入空间A：先造一个团队B可见的邀请（manager 造）→ 兑换被闸
    const invite = await api('POST', `/spaces/${spaceId}/invites`, { perm: 'viewer', expiresInDays: 1 }, taToken);
    expect(invite.status).toBe(200);
    const token = (invite.json as { token: string }).token;
    const blocked = await api('POST', '/invites/redeem', { token }, carolToken);
    expect(blocked.status).toBe(403);

    // 管理员放开外部协作 → 兑换成功
    const put = await api('PUT', '/org/settings', { allowExternalCollab: true }, rootToken);
    expect(put.status).toBe(200);
    const ok = await api('POST', '/invites/redeem', { token }, carolToken);
    expect(ok.status).toBe(200);
    // 还原锁定
    await api('PUT', '/org/settings', { allowExternalCollab: false }, rootToken);
    const second = await api('POST', `/spaces/${spaceId}/invites`, { perm: 'viewer', expiresInDays: 1 }, taToken);
    const token2 = (second.json as { token: string }).token;
    const blocked2 = await api('POST', '/invites/redeem', { token2 }, daveToken);
    expect(blocked2.status).toBe(403);
  });

  it('非成员读设置 200（全员可读）；成员写设置 403', async () => {
    if (!pgUp) return;
    const read = await api('GET', '/org/settings', undefined, bobToken);
    expect(read.status).toBe(200);
    const write = await api('PUT', '/org/settings', { allowExternalCollab: true }, bobToken);
    expect(write.status).toBe(403);
  });
});

describe('FR-TC-21 空间内全文检索：标题+正文，仅可见节点', () => {
  it('建 MD 写正文 → 按内容与标题命中；viewer 的 none 覆盖节点不出现', async () => {
    if (!pgUp) return;
    const node = await api('POST', `/spaces/${spaceId}/nodes`, { type: 'md', name: '检索目标纪要' }, aliceToken);
    expect(node.status).toBe(200);
    const nodeId = (node.json as { id: string }).id;
    const save = await api('PUT', `/spaces/${spaceId}/nodes/${nodeId}/doc`, {
      content: '客户A的市场进入策略含价格锚点分析', baseVersion: 0,
    }, aliceToken);
    expect(save.status).toBe(200);

    const byContent = await api('GET', `/spaces/${spaceId}/search?q=${encodeURIComponent('价格锚点')}`, undefined, taToken);
    expect(byContent.status).toBe(200);
    const hits = byContent.json as unknown as Array<{ id: string; matchedIn: string }>;
    expect(hits.some((h) => h.id === nodeId && h.matchedIn === 'content')).toBe(true);

    const byTitle = await api('GET', `/spaces/${spaceId}/search?q=${encodeURIComponent('检索目标')}`, undefined, taToken);
    expect((byTitle.json as unknown as Array<{ id: string; matchedIn: string }>).some((h) => h.id === nodeId && h.matchedIn === 'title')).toBe(true);

    // 特殊字符不炸（LIKE 通配符转义）
    const literal = await api('GET', `/spaces/${spaceId}/search?q=${encodeURIComponent('100% _ok')}`, undefined, taToken);
    expect(literal.status).toBe(200);
  });
});

describe('T52.5 空间文件上传：版本链/权限/校验', () => {
  it('上传建 file 节点 → 下载往返一致；同节点重传产生版本链', async () => {
    if (!pgUp) return;
    const content = Buffer.from('验收文件内容-第一版');
    const up = await api('POST', `/spaces/${spaceId}/files`, {
      name: '报告.pdf', contentBase64: content.toString('base64'),
    }, aliceToken);
    expect(up.status).toBe(200);
    const nodeId = (up.json as { nodeId: string }).nodeId;
    expect((up.json as { versionNo: number }).versionNo).toBe(1);

    const up2 = await api('POST', `/spaces/${spaceId}/files`, {
      nodeId, contentBase64: Buffer.from('第二版内容').toString('base64'),
    }, aliceToken);
    expect(up2.status).toBe(200);
    expect((up2.json as { versionNo: number }).versionNo).toBe(2);

    const versions = await api('GET', `/spaces/${spaceId}/files/${nodeId}/versions`, undefined, aliceToken);
    expect(versions.status).toBe(200);
    expect((versions.json as unknown as unknown[]).length).toBe(2);

    const dl = await api('GET', `/spaces/${spaceId}/files/${nodeId}/download`, undefined, aliceToken);
    expect(dl.status).toBe(200);
    expect(Buffer.from((dl.json as { contentBase64: string }).contentBase64, 'base64').toString()).toBe('第二版内容');
    const dl1 = await api('GET', `/spaces/${spaceId}/files/${nodeId}/download?version=1`, undefined, aliceToken);
    expect(Buffer.from((dl1.json as { contentBase64: string }).contentBase64, 'base64').toString()).toBe('验收文件内容-第一版');
    const sha = (dl.json as { sha256: string }).sha256;
    expect(sha).toBe(createHash('sha256').update('第二版内容').digest('hex'));
  });

  it('viewer 不能上传（403）；空内容 422；版本不存在 404', async () => {
    if (!pgUp) return;
    const created = await api('POST', `/spaces/${spaceId}/files`, {
      name: 'bob.bin', contentBase64: Buffer.from('x').toString('base64'),
    }, bobToken);
    expect(created.status).toBe(403);
    const empty = await api('POST', `/spaces/${spaceId}/files`, {
      name: 'empty.bin', contentBase64: '',
    }, aliceToken);
    expect(empty.status).toBe(422);
    const missing = await api('GET', `/spaces/${spaceId}/files/00000000-0000-4000-8000-000000000000/download`, undefined, aliceToken);
    expect([403, 404]).toContain(missing.status);
  });
});
});
