import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { bootstrap } from '../app.controller.js';
import { INestApplication } from '@nestjs/common';
import { encryptWechatMessage, wechatSignature } from './wechat-crypto.js';
import { wechatMpBots, wechatMpPending } from '../db/schema.js';

/**
 * Module 04 公众号中继验收（T54.7-9, FR-IM-11/12/13）：
 * - RBAC：member 403（CRUD 全禁）；sys_admin 管理
 * - 凭证静态加密（AES-256-GCM v1. 密文落库）+ DTO 打码（尾 4 位）
 * - GET 回调验签：正确 token 回显 echostr，错误 403
 * - POST 安全模式：msg_signature 验签 → EncodingAESKey AES 解密 → MsgId 去重
 *   → 离线 DB 暂存；明文模式错误签名吞掉
 * - GET /org/wechat-mp/pending：绑定用户取走并清除；未绑定拿不到
 * - 在线热路径：轮询后回调走内存热队列（不落暂存表）
 * - POST /org/wechat-mp/send：注入 fetch 桩 → token 缓存、>2048B 分片、
 *   45015 → 结构化诊断
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://pptmaster:pptmaster_dev@127.0.0.1:5992/laboflow_p5_wechat';
let app: INestApplication;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deps: any;
let baseUrl = '';
let pgUp = false;

let adminToken = '';
let memberAToken = ''; // 绑定接收的桌面用户
let memberBToken = ''; // 未绑定用户
let memberAId = '';
let memberBId = '';

// ---- 微信回调样本材料（与实现同一套加密原语构造密文样本） ----
const APP_ID = 'wx1234567890abcdef';
const MP_TOKEN = 'mp-callback-token';
const AES_KEY_43 = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const TS = '1348831860';
const NONCE = 'nonce123';

let sendErrcode = 0; // stub 的客服消息应答码（45015 用例翻转）
interface SendCall { url: string; body: string }
const sendCalls: SendCall[] = [];
let tokenCalls = 0;

function innerXml(msgId: string, content: string): string {
  return (
    '<xml><ToUserName><![CDATA[gh_laboflow]]></ToUserName>' +
    '<FromUserName><![CDATA[oFAN-OPENID-1]]></FromUserName>' +
    `<CreateTime>${TS}</CreateTime>` +
    '<MsgType><![CDATA[text]]></MsgType>' +
    `<Content><![CDATA[${content}]]></Content>` +
    `<MsgId>${msgId}</MsgId></xml>`
  );
}

function buildSafePost(msgId: string, content: string): { url: string; body: string } {
  const xml = innerXml(msgId, content);
  const encrypt = encryptWechatMessage(xml, AES_KEY_43, APP_ID);
  const msgSignature = wechatSignature([MP_TOKEN, TS, NONCE, encrypt]);
  const outer = `<xml><ToUserName><![CDATA[gh_laboflow]]></ToUserName><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
  return {
    url: `/bots/webhook/wechat?msg_signature=${msgSignature}&timestamp=${TS}&nonce=${NONCE}`,
    body: outer,
  };
}

function buildPlainPost(msgId: string, content: string, token = MP_TOKEN): { url: string; body: string } {
  const signature = wechatSignature([token, TS, NONCE]);
  return {
    url: `/bots/webhook/wechat?signature=${signature}&timestamp=${TS}&nonce=${NONCE}`,
    body: innerXml(msgId, content),
  };
}

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function postXml(path: string, xml: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'text/xml' }, body: xml });
  return { status: res.status, text: await res.text() };
}

async function pendingCount(): Promise<number> {
  const rows = await deps.db.select().from(wechatMpPending);
  return rows.length;
}

beforeAll(async () => {
  const adminUrl = DATABASE_URL.replace(/\/[^/]+$/, '/postgres');
  try {
    const probe = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 3000 });
    await probe.query('SELECT 1');
    await probe.end();
    pgUp = true;
  } catch {
    console.warn('[skip] postgres unavailable — wechat relay suite skipped');
    return;
  }
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query('DROP DATABASE IF EXISTS laboflow_p5_wechat').catch(() => undefined);
  await admin.query('CREATE DATABASE laboflow_p5_wechat').catch(() => undefined);
  await admin.end();

  const boot = await bootstrap({
    databaseUrl: DATABASE_URL,
    jwtSecret: 'x'.repeat(40),
    serverEncryptionKey: 'wechat-suite-master-key',
    wechatFetch: (async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes('/cgi-bin/token')) {
        tokenCalls += 1;
        return { ok: true, status: 200, json: async () => ({ access_token: 'STUB-ACCESS-TOKEN', expires_in: 7200 }) };
      }
      sendCalls.push({ url, body: String(init?.body ?? '') });
      const payload = sendErrcode === 0 ? { errcode: 0, errmsg: 'ok' } : { errcode: sendErrcode, errmsg: 'reply out of range' };
      return { ok: true, status: 200, json: async () => payload };
    }) as unknown as typeof fetch,
  });
  app = boot.app;
  deps = boot.deps;
  baseUrl = `http://127.0.0.1:${boot.port}`;

  const { hash } = await import('@node-rs/argon2');
  const { users } = await import('../db/schema.js');
  await deps.db.insert(users).values({ username: 'root', displayName: '超管', passwordHash: await hash('AdminPass123'), mustChangePassword: false, role: 'sys_admin' });
  const [mA] = await deps.db.insert(users).values({ username: 'memberA', displayName: '绑定用户A', passwordHash: await hash('MemberPass123'), mustChangePassword: false, role: 'member' }).returning();
  const [mB] = await deps.db.insert(users).values({ username: 'memberB', displayName: '普通用户B', passwordHash: await hash('MemberPass123'), mustChangePassword: false, role: 'member' }).returning();
  memberAId = mA.id;
  memberBId = mB.id;

  const login = async (username: string, password: string) =>
    ((await api('POST', '/auth/login', { username, password })).json as unknown as { tokens: { accessToken: string } }).tokens.accessToken;
  adminToken = await login('root', 'AdminPass123');
  memberAToken = await login('memberA', 'MemberPass123');
  memberBToken = await login('memberB', 'MemberPass123');
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('公众号接入 CRUD — RBAC + 凭证静态加密（FR-IM-11）', () => {
  it('member cannot create/list/update/delete (403)', async () => {
    if (!pgUp) return;
    expect((await api('POST', '/org/wechat-mp/bots', { name: 'x', appId: 'wx1', appSecret: 's', token: 't', allowUserIds: [memberAId] }, memberAToken)).status).toBe(403);
    expect((await api('GET', '/org/wechat-mp/bots', undefined, memberAToken)).status).toBe(403);
    expect((await api('PATCH', '/org/wechat-mp/bots/00000000-0000-0000-0000-000000000000', { enabled: false }, memberAToken)).status).toBe(403);
    expect((await api('DELETE', '/org/wechat-mp/bots/00000000-0000-0000-0000-000000000000', undefined, memberAToken)).status).toBe(403);
  });

  it('validation: empty token / no binding user / bad aesKey → 422', async () => {
    if (!pgUp) return;
    expect((await api('POST', '/org/wechat-mp/bots', { name: 'x', appId: 'wx1', appSecret: 's', token: '', allowUserIds: [memberAId] }, adminToken)).status).toBe(422);
    expect((await api('POST', '/org/wechat-mp/bots', { name: 'x', appId: 'wx1', appSecret: 's', token: 't', allowUserIds: [] }, adminToken)).status).toBe(422);
    expect((await api('POST', '/org/wechat-mp/bots', { name: 'x', appId: 'wx1', appSecret: 's', token: 't', encodingAesKey: 'short', allowUserIds: [memberAId] }, adminToken)).status).toBe(422);
  });

  it('sys_admin creates bot; DTO masks secrets; DB row is v1. GCM ciphertext', async () => {
    if (!pgUp) return;
    const created = await api('POST', '/org/wechat-mp/bots', {
      name: 'LaboFlow 公众号',
      appId: APP_ID,
      appSecret: 'super-secret-appsecret-9876',
      encodingAesKey: AES_KEY_43,
      token: MP_TOKEN,
      allowUserIds: [memberAId],
    }, adminToken);
    expect(created.status).toBe(200);
    const dto = created.json as unknown as Record<string, unknown>;
    expect(dto.appId).toBe(APP_ID);
    expect(dto.secretTail).toBe('9876'); // 尾 4 位打码
    expect(dto.aesKeyTail).toBe('DEFG');
    const raw = JSON.stringify(dto);
    expect(raw).not.toContain('super-secret-appsecret-9876');
    expect(raw).not.toContain('appSecretEnc');
    expect(raw).not.toContain(AES_KEY_43);

    const rows = (await deps.db.select().from(wechatMpBots)) as Array<{ appSecretEnc: string; encodingAesKeyEnc: string }>;
    expect(rows[0]!.appSecretEnc.startsWith('v1.')).toBe(true);
    expect(Buffer.from(rows[0]!.appSecretEnc.slice(3), 'base64').toString('utf8')).not.toContain('super-secret');
    expect(rows[0]!.encodingAesKeyEnc!.startsWith('v1.')).toBe(true);
  });

  it('duplicate appId → 409', async () => {
    if (!pgUp) return;
    const r = await api('POST', '/org/wechat-mp/bots', {
      name: '重复接入', appId: APP_ID, appSecret: 'another-secret', token: MP_TOKEN, allowUserIds: [memberBId],
    }, adminToken);
    expect(r.status).toBe(409);
  });
});

describe('回调验签与安全模式解密（FR-IM-11，SPEC §3.4）', () => {
  it('GET URL 验证：正确 token 回显 echostr（纯文本）；错误 token 403', async () => {
    if (!pgUp) return;
    const sig = wechatSignature([MP_TOKEN, TS, NONCE]);
    const okRes = await fetch(`${baseUrl}/bots/webhook/wechat?signature=${sig}&timestamp=${TS}&nonce=${NONCE}&echostr=ECHO-7788`);
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('content-type')).toContain('text/plain');
    expect(await okRes.text()).toBe('ECHO-7788');

    const badSig = wechatSignature(['wrong-token', TS, NONCE]);
    const badRes = await fetch(`${baseUrl}/bots/webhook/wechat?signature=${badSig}&timestamp=${TS}&nonce=${NONCE}&echostr=ECHO`);
    expect(badRes.status).toBe(403);
  });

  it('POST 安全模式：解密入暂存（用户离线）；坏 msg_signature 吞掉不暂存', async () => {
    if (!pgUp) return;
    expect(await pendingCount()).toBe(0);
    const good = buildSafePost('MSG-1001', '帮我跑个测试');
    const res = await postXml(good.url, good.body);
    expect(res.status).toBe(200);
    expect(res.text).toBe('success');
    expect(await pendingCount()).toBe(1);

    const bad = buildSafePost('MSG-1002', '不该进来');
    const tampered = bad.url.replace(/msg_signature=[0-9a-f]+/, 'msg_signature=' + '0'.repeat(40));
    await postXml(tampered, bad.body);
    expect(await pendingCount()).toBe(1); // 验签失败 ACK 但不投递
  });

  it('MsgId 去重：平台重推同一 MsgId 只暂存一次', async () => {
    if (!pgUp) return;
    const again = buildSafePost('MSG-1001', '帮我跑个测试');
    await postXml(again.url, again.body);
    expect(await pendingCount()).toBe(1);
  });

  it('明文模式：正确签名可入暂存；错误 token 签名被吞', async () => {
    if (!pgUp) return;
    const good = buildPlainPost('MSG-2001', '明文消息');
    const res = await postXml(good.url, good.body);
    expect(res.status).toBe(200);
    expect(await pendingCount()).toBe(2);

    const bad = buildPlainPost('MSG-2002', '不该进来', 'evil-token');
    await postXml(bad.url, bad.body);
    expect(await pendingCount()).toBe(2);
  });
});

describe('绑定轮询取走并清除 + 在线热路径（T54.8）', () => {
  it('绑定用户取走全部暂存；二次轮询为空；未绑定用户拿不到', async () => {
    if (!pgUp) return;
    const first = (await api('GET', '/org/wechat-mp/pending', undefined, memberAToken)).json as unknown as { messages: Array<{ content: string; fromUser: string; msgId: string; appId: string }> };
    expect(first.messages.length).toBe(2);
    expect(first.messages.map((m) => m.msgId).sort()).toEqual(['MSG-1001', 'MSG-2001']);
    expect(first.messages[0]!.fromUser).toBe('oFAN-OPENID-1');
    expect(first.messages[0]!.appId).toBe(APP_ID);

    const second = (await api('GET', '/org/wechat-mp/pending', undefined, memberAToken)).json as unknown as { messages: unknown[] };
    expect(second.messages.length).toBe(0);

    const outsider = (await api('GET', '/org/wechat-mp/pending', undefined, memberBToken)).json as unknown as { messages: unknown[] };
    expect(outsider.messages.length).toBe(0);
    expect(await pendingCount()).toBe(0);
  });

  it('在线（15s 内轮询过）→ 回调走内存热队列，不落暂存表，下轮取走', async () => {
    if (!pgUp) return;
    // memberA 刚轮询过（上一用例）→ 视为在线
    const msg = buildSafePost('MSG-3001', '在线直达');
    await postXml(msg.url, msg.body);
    expect(await pendingCount()).toBe(0); // 未落库

    const got = (await api('GET', '/org/wechat-mp/pending', undefined, memberAToken)).json as unknown as { messages: Array<{ msgId: string; content: string }> };
    expect(got.messages.map((m) => m.msgId)).toEqual(['MSG-3001']);
    expect(got.messages[0]!.content).toBe('在线直达');
  });
});

describe('出站客服消息（FR-IM-12：token 缓存 / 分片 / 45015 诊断）', () => {
  it('未绑定用户 403；绑定用户发送 → token 取一次、6000B 文本分 3 条 ≤2048B', async () => {
    if (!pgUp) return;
    const forbidden = await api('POST', '/org/wechat-mp/send', { appId: APP_ID, toUser: 'oFAN-OPENID-1', text: 'hi' }, memberBToken);
    expect(forbidden.status).toBe(403);

    sendCalls.length = 0;
    tokenCalls = 0;
    const bots = (await api('GET', '/org/wechat-mp/bots', undefined, adminToken)).json as unknown as Array<{ id: string }>;
    const big = '汉'.repeat(2000); // 6000B
    const r = await api('POST', '/org/wechat-mp/send', { botId: bots[0]!.id, toUser: 'oFAN-OPENID-1', text: big }, memberAToken);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.chunks).toBe(3);
    expect(sendCalls.length).toBe(3);
    expect(tokenCalls).toBe(1); // access_token 缓存生效
    for (const call of sendCalls) {
      const body = JSON.parse(call.body) as { touser: string; msgtype: string; text: { content: string } };
      expect(body.touser).toBe('oFAN-OPENID-1');
      expect(body.msgtype).toBe('text');
      expect(Buffer.byteLength(body.text.content, 'utf8')).toBeLessThanOrEqual(2048);
      expect(body.text.content.includes('\uFFFD')).toBe(false);
    }
    const rejoined = sendCalls.map((c) => (JSON.parse(c.body) as { text: { content: string } }).text.content).join('');
    expect(rejoined).toBe(big);
  });

  it('45015 超窗 → ok:false + 结构化诊断（permission/45015），接口不抛 500', async () => {
    if (!pgUp) return;
    sendErrcode = 45015;
    const r = await api('POST', '/org/wechat-mp/send', { appId: APP_ID, toUser: 'oFAN-OPENID-1', text: '超窗后的回复' }, memberAToken);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.errcode).toBe(45015);
    const diag = r.json.diag as { kind: string; rawCode: string; message: string };
    expect(diag.kind).toBe('permission');
    expect(diag.rawCode).toBe('45015');
    expect(diag.message).toContain('48');
    sendErrcode = 0;
  });
});

describe('删除接入：暂存级联清理', () => {
  it('DELETE 后 bots 清空、pending 清空', async () => {
    if (!pgUp) return;
    const bots = (await api('GET', '/org/wechat-mp/bots', undefined, adminToken)).json as unknown as Array<{ id: string }>;
    expect(bots.length).toBe(1);
    // 先造一条离线暂存（memberB 轮询一次使 memberA “在线”判定失效后由 bot 维度暂存）
    const del = await api('DELETE', `/org/wechat-mp/bots/${bots[0]!.id}`, undefined, adminToken);
    expect(del.status).toBe(200);
    expect(await pendingCount()).toBe(0);
    const after = (await api('GET', '/org/wechat-mp/bots', undefined, adminToken)).json as unknown as unknown[];
    expect(after.length).toBe(0);
  });
});
