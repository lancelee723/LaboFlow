import { and, eq, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { wechatMpBots, wechatMpPending } from '../db/schema.js';
import { SecretBox } from '../kb/secret-box.js';
import {
  decryptWechatMessage,
  parseWechatXml,
  verifyWechatSignature,
} from './wechat-crypto.js';
import {
  chunkWechatText,
  mapWechatSendDiag,
  WechatApiError,
  WechatMpApiClient,
  type WechatDiag,
  type WechatFetchLike,
} from './wechat-mp.client.js';

/**
 * Module 04 微信公众号中继（T54.7-9, FR-IM-11/12/13, SPEC §2.2/§3.4）。
 *
 * 链路：微信 → POST /bots/webhook/wechat（验签/AES 解密）→ 按 ToUserName 查 bot
 *  → MsgId 去重 → 绑定的桌面客户端在线（15s 内有过 pending 轮询）→ 内存热队列，
 *    下次 5s 轮询即达；离线 → wechat_mp_pending 表暂存（24h 清理，重投即删）。
 *  → 客户端经 GET /org/wechat-mp/pending（JWT）取走并清除；执行完经
 *    POST /org/wechat-mp/send（JWT）→ 客服消息 API 回推用户。
 *
 * 被动回复语义（FR-IM-12，代码级约定）：微信要求 5s 内应答，而长任务无法在
 * 5s 内完成 → 中继对每条回调立即 200 'success'（ACK 后平台停止重推），
 * 「任务已开始」与最终结果都走客服消息（用户消息开启的 48h/5 条窗口）。
 * 出站文本 >2048B 自动分片；45015 超窗 → 结构化诊断后丢弃（记日志）。
 *
 * 安全（SPEC §4）：app_secret / EncodingAESKey 经 SecretBox AES-256-GCM
 * 加密静态存储；列表 DTO 只回尾 4 位；token 为验签公开材料按原文存取。
 */

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
/** 桌面端 5s 轮询 → 15s（≈3 个周期）无轮询即视为离线。 */
const ONLINE_WINDOW_MS = 15_000;
const DEDUP_LRU_MAX = 4096;

export type WechatMpMessagePayload = {
  botId: string;
  appId: string;
  fromUser: string;
  msgType: string;
  content: string;
  msgId: string;
  createTime: number;
  receivedAt: number;
};

export interface WechatMpBotDto {
  id: string;
  name: string;
  appId: string;
  token: string;
  secretTail: string;
  aesKeyTail: string;
  allowUserIds: string[];
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface WechatMpPendingMessage extends WechatMpMessagePayload {
  id: string;
}

export interface WechatMpSendResult {
  ok: boolean;
  chunks?: number;
  errcode?: number;
  errmsg?: string;
  diag?: WechatDiag;
}

export interface WechatIngestResult {
  status: number;
  reply: string;
}

export interface WechatMpIngestInput {
  body: string;
  /** GET/明文模式验签参数（微信 query 携带）。 */
  signature?: string;
  /** 安全模式签名参数。 */
  msgSignature?: string;
  timestamp?: string;
  nonce?: string;
}

export interface WechatMpUpsertInput {
  name?: string;
  appId?: string;
  appSecret?: string;
  encodingAesKey?: string;
  token?: string;
  allowUserIds?: string[];
  enabled?: boolean;
}

type ActorLike = { userId: string; role: string };

export class WechatMpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WechatMpError';
  }
}

const SUCCESS: WechatIngestResult = { status: 200, reply: 'success' };

/** MsgId LRU 去重：微信 5s 超时/重试会重推同一 MsgId，必须只投递一次。 */
export class MsgIdDeduper {
  private seen = new Set<string>();

  check(id: string): boolean {
    if (!id) return true;
    if (this.seen.has(id)) return false;
    if (this.seen.size >= DEDUP_LRU_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(id);
    return true;
  }
}

export interface WechatMpServiceOptions {
  /** 出站微信 API fetch（测试桩）。 */
  fetchImpl?: WechatFetchLike;
  now?: () => number;
  /** 供测试注入的出站客户端工厂。 */
  clientFactory?: (bot: { appId: string; appSecret: string }) => WechatMpApiClient;
}

export class WechatMpService {
  private readonly now: () => number;
  private readonly fetchImpl: WechatFetchLike | undefined;
  private readonly clientFactory: (bot: { appId: string; appSecret: string }) => WechatMpApiClient;
  private readonly dedup = new MsgIdDeduper();
  /** 在线热队列：userId → 待取消息（15s 无轮询则回落 DB 暂存）。 */
  private hotQueue = new Map<string, WechatMpMessagePayload[]>();
  /** userId → 最近一次 pending 轮询时间（在线判定）。 */
  private lastPollAt = new Map<string, number>();
  private clients = new Map<string, WechatMpApiClient>();
  private lastSweepAt = 0;

  constructor(
    private readonly db: NodePgDatabase<Record<string, never>>,
    private readonly box: SecretBox,
    options: WechatMpServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl;
    this.clientFactory =
      options.clientFactory ??
      ((bot) =>
        new WechatMpApiClient({
          appId: bot.appId,
          appSecret: bot.appSecret,
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        }));
  }

  // -------------------------------------------------------------------------
  // 管理台 CRUD（sys_admin，channel.manage）
  // -------------------------------------------------------------------------

  private normalizeUpsert(input: WechatMpUpsertInput, partial: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!partial || input.name !== undefined) {
      const name = String(input.name ?? '').trim();
      if (!name) throw new WechatMpError(422, 'ENAME', '名称不能为空');
      out.name = name;
    }
    if (!partial || input.appId !== undefined) {
      const appId = String(input.appId ?? '').trim();
      if (!appId) throw new WechatMpError(422, 'EAPPID', 'AppID 不能为空');
      out.appId = appId;
    }
    if (input.appSecret !== undefined && String(input.appSecret).length > 0) {
      out.appSecret = String(input.appSecret);
    }
    if (!partial && !out.appSecret) {
      throw new WechatMpError(422, 'ESECRET', 'AppSecret 不能为空');
    }
    if (input.encodingAesKey !== undefined) {
      const key = String(input.encodingAesKey).trim();
      if (key === '') {
        out.encodingAesKey = null; // 明确清空 → 明文模式
      } else if (!/^[A-Za-z0-9]{43}$/.test(key)) {
        throw new WechatMpError(422, 'EAESKEY', 'EncodingAESKey 须为 43 位字母数字（公众平台「消息加解密密钥」）');
      } else {
        out.encodingAesKey = key;
      }
    }
    if (!partial || input.token !== undefined) {
      const token = String(input.token ?? '').trim();
      if (!token) throw new WechatMpError(422, 'ETOKEN', 'Token 不能为空（回调配置的令牌）');
      out.token = token;
    }
    if (!partial || input.allowUserIds !== undefined) {
      const ids = Array.isArray(input.allowUserIds)
        ? [...new Set(input.allowUserIds.map(String).map((s) => s.trim()).filter(Boolean))]
        : [];
      if (ids.length === 0) {
        throw new WechatMpError(422, 'EBINDING', '至少选择一个接收消息的桌面用户（绑定）');
      }
      out.allowUserIds = ids;
    }
    if (input.enabled !== undefined) out.enabled = Boolean(input.enabled);
    return out;
  }

  async create(input: WechatMpUpsertInput, actorId: string): Promise<WechatMpBotDto> {
    const v = this.normalizeUpsert(input, false);
    const appId = v.appId as string;
    const dup = await this.db
      .select({ id: wechatMpBots.id })
      .from(wechatMpBots)
      .where(and(eq(wechatMpBots.orgId, 'default'), eq(wechatMpBots.appId, appId)))
      .limit(1);
    if (dup.length > 0) throw new WechatMpError(409, 'ECONFLICT', '该 AppID 的公众号已接入');
    const [row] = await this.db
      .insert(wechatMpBots)
      .values({
        orgId: 'default',
        name: v.name as string,
        appId,
        appSecretEnc: this.box.encrypt(v.appSecret as string),
        encodingAesKeyEnc:
          v.encodingAesKey !== undefined && v.encodingAesKey !== null
            ? this.box.encrypt(v.encodingAesKey as string)
            : null,
        token: v.token as string,
        allowUserIds: v.allowUserIds as string[],
        enabled: (v.enabled as boolean | undefined) ?? true,
        createdBy: actorId,
      })
      .returning();
    return this.toDto(row!);
  }

  async list(): Promise<WechatMpBotDto[]> {
    const rows = await this.db.select().from(wechatMpBots);
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return rows.map((r) => this.toDto(r));
  }

  async update(id: string, patch: WechatMpUpsertInput): Promise<WechatMpBotDto> {
    const [row] = await this.db.select().from(wechatMpBots).where(eq(wechatMpBots.id, id)).limit(1);
    if (!row) throw new WechatMpError(404, 'ENOENT', '公众号接入不存在');
    const v = this.normalizeUpsert(patch, true);
    if (v.appId !== undefined && v.appId !== row.appId) {
      const dup = await this.db
        .select({ id: wechatMpBots.id })
        .from(wechatMpBots)
        .where(and(eq(wechatMpBots.orgId, row.orgId), eq(wechatMpBots.appId, v.appId as string)))
        .limit(1);
      if (dup.length > 0) throw new WechatMpError(409, 'ECONFLICT', '该 AppID 的公众号已接入');
    }
    const set: Record<string, unknown> = {};
    for (const k of ['name', 'appId', 'token', 'allowUserIds', 'enabled'] as const) {
      if (v[k] !== undefined) set[k] = v[k];
    }
    if (v.appSecret !== undefined) {
      set.appSecretEnc = this.box.encrypt(v.appSecret as string); // 留空=不变（normalize 已滤掉空串）
    }
    if (v.encodingAesKey !== undefined) {
      set.encodingAesKeyEnc =
        v.encodingAesKey !== null ? this.box.encrypt(v.encodingAesKey as string) : null;
    }
    const [updated] = await this.db.update(wechatMpBots).set(set).where(eq(wechatMpBots.id, id)).returning();
    this.clients.delete(id); // 凭证可能已轮换 → 出站客户端（含 token 缓存）重建
    return this.toDto(updated!);
  }

  async remove(id: string): Promise<WechatMpBotDto> {
    const rows = await this.db.delete(wechatMpBots).where(eq(wechatMpBots.id, id)).returning();
    if (rows.length === 0) throw new WechatMpError(404, 'ENOENT', '公众号接入不存在');
    this.clients.delete(id);
    await this.db.delete(wechatMpPending).where(eq(wechatMpPending.botId, id)); // 级联兜底（表上有 FK cascade）
    return this.toDto(rows[0]!);
  }

  private toDto(r: typeof wechatMpBots.$inferSelect): WechatMpBotDto {
    return {
      id: r.id,
      name: r.name,
      appId: r.appId,
      token: r.token,
      secretTail: this.box.safeTail(r.appSecretEnc),
      aesKeyTail: this.box.safeTail(r.encodingAesKeyEnc),
      allowUserIds: (r.allowUserIds as string[]) ?? [],
      enabled: r.enabled,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // 回调中继（公开路由，FR-IM-11）
  // -------------------------------------------------------------------------

  /** GET 验签（URL 配置）：任一启用 bot 的 token 命中即通过，原样返回 echostr。 */
  async verifyUrlChallenge(query: {
    signature?: string;
    timestamp?: string;
    nonce?: string;
    echostr?: string;
  }): Promise<string | null> {
    if (!query.echostr) return null;
    const bots = await this.db.select().from(wechatMpBots).where(eq(wechatMpBots.enabled, true));
    for (const bot of bots) {
      if (
        verifyWechatSignature({
          token: bot.token,
          timestamp: query.timestamp,
          nonce: query.nonce,
          signature: query.signature,
        })
      ) {
        return query.echostr;
      }
    }
    return null;
  }

  /**
   * POST 回调入口。任何失败都吞成 200 'success'：平台 5s 无应答/非 200 会
   * 重试 3 次；验签失败/未知 bot 的重推毫无意义，ACK 掉最安全（诊断走日志）。
   */
  async handleIngest(input: WechatMpIngestInput): Promise<WechatIngestResult> {
    try {
      const outer = parseWechatXml(String(input.body ?? ''));
      const encrypt = outer.Encrypt;
      const enabledBots = await this.db.select().from(wechatMpBots).where(eq(wechatMpBots.enabled, true));
      let bot: typeof wechatMpBots.$inferSelect | undefined;
      let fields = outer;

      if (encrypt) {
        // 安全模式：msg_signature = sha1(sort(token, timestamp, nonce, encrypt))，先验签后解密
        for (const b of enabledBots) {
          if (
            verifyWechatSignature({
              token: b.token,
              timestamp: input.timestamp,
              nonce: input.nonce,
              signature: input.msgSignature,
              encrypt,
            })
          ) {
            bot = b;
            break;
          }
        }
        if (!bot) return SUCCESS;
        if (!bot.encodingAesKeyEnc) return SUCCESS; // 配了密文但未配 AESKey → 无法处理
        const aesKey = this.box.decrypt(bot.encodingAesKeyEnc);
        const decrypted = decryptWechatMessage(encrypt, aesKey);
        if (decrypted.receiveId && decrypted.receiveId !== bot.appId) return SUCCESS;
        fields = parseWechatXml(decrypted.xml);
      } else {
        // 明文模式：直接取业务字段，按 ToUserName 验 token 签名
        bot = await this.resolveBotByToUserName(enabledBots, outer.ToUserName);
        if (!bot) return SUCCESS;
        if (
          !verifyWechatSignature({
            token: bot.token,
            timestamp: input.timestamp,
            nonce: input.nonce,
            signature: input.signature,
          })
        ) {
          return SUCCESS;
        }
      }

      // v1 只消费文本指令（image/voice/link/event ACK 丢弃；FR-IM-12 范围=文本）
      const msgType = fields.MsgType ?? '';
      const content = (fields.Content ?? '').trim();
      if (msgType !== 'text' || !content) return SUCCESS;

      const msgId = fields.MsgId || `${fields.FromUserName ?? ''}:${fields.CreateTime ?? ''}`;
      if (!this.dedup.check(msgId)) return SUCCESS; // 平台重推（5s 超时重试 3 次）

      const payload: WechatMpMessagePayload = {
        botId: bot.id,
        appId: bot.appId,
        fromUser: fields.FromUserName ?? '',
        msgType,
        content,
        msgId,
        createTime: Number(fields.CreateTime ?? 0) || 0,
        receivedAt: this.now(),
      };
      if (!payload.fromUser) return SUCCESS;
      await this.routeMessage(bot, payload);
    } catch {
      // 解密失败/库异常等一律 ACK（诊断在服务端日志；重推无益）
    }
    return SUCCESS;
  }

  /**
   * ToUserName = 接收方账号（公众号原始 ID gh_…）。协议上与 AppID（wx…）不同，
   * 但按任务约定优先 app_id 精确匹配；测试号场景 ToUserName 是 gh_ 原始 ID，
   * 单组织单 bot 时回落到唯一启用的 bot（v1 简化，见方法注释）。
   */
  private async resolveBotByToUserName(
    enabledBots: Array<typeof wechatMpBots.$inferSelect>,
    toUserName?: string,
  ): Promise<typeof wechatMpBots.$inferSelect | undefined> {
    const byAppId = enabledBots.find((b) => b.appId && b.appId === toUserName);
    if (byAppId) return byAppId;
    return enabledBots.length === 1 ? enabledBots[0] : undefined;
  }

  private async routeMessage(
    bot: typeof wechatMpBots.$inferSelect,
    payload: WechatMpMessagePayload,
  ): Promise<void> {
    await this.sweepIfDue();
    const boundUsers = ((bot.allowUserIds as string[]) ?? []).filter(Boolean);
    const now = this.now();
    let onlineUser: string | null = null;
    let onlineAt = -1;
    for (const uid of boundUsers) {
      const at = this.lastPollAt.get(uid) ?? 0;
      if (at > onlineAt) {
        onlineAt = at;
        onlineUser = uid;
      }
    }
    if (onlineUser && now - onlineAt < ONLINE_WINDOW_MS) {
      // 在线：内存热队列，下一次 5s 轮询即达（免落库）
      const q = this.hotQueue.get(onlineUser) ?? [];
      q.push(payload);
      this.hotQueue.set(onlineUser, q);
      return;
    }
    // 离线：DB 暂存 ≤24h；按 bot 维度一行，首个轮询的绑定用户取走（多绑定见类注释）
    await this.db.insert(wechatMpPending).values({ botId: bot.id, payload });
  }

  // -------------------------------------------------------------------------
  // 桌面端配对轮询（GET /org/wechat-mp/pending）与出站（POST /org/wechat-mp/send）
  // -------------------------------------------------------------------------

  /** 返回并清除该用户可取的消息（热队列优先；热队列为空才消费 DB 暂存）。 */
  async pollPending(actor: ActorLike): Promise<{ messages: WechatMpPendingMessage[] }> {
    this.lastPollAt.set(actor.userId, this.now());
    await this.sweepIfDue();
    const out: WechatMpPendingMessage[] = [];
    const hot = this.hotQueue.get(actor.userId);
    if (hot && hot.length > 0) {
      for (const p of hot.splice(0)) out.push({ id: `hot:${p.msgId}`, ...p });
    }
    if (out.length === 0) {
      const bots = await this.db.select().from(wechatMpBots).where(eq(wechatMpBots.enabled, true));
      const myBotIds = bots
        .filter((b) => ((b.allowUserIds as string[]) ?? []).includes(actor.userId))
        .map((b) => b.id);
      for (const botId of myBotIds) {
        const rows = await this.db
          .delete(wechatMpPending)
          .where(eq(wechatMpPending.botId, botId))
          .returning();
        for (const r of rows) {
          const p = r.payload as WechatMpMessagePayload;
          out.push({ id: r.id, ...p });
        }
      }
    }
    return { messages: out };
  }

  /** 出站：{botId|appId, toUser, text} → 客服消息；>2048B 分片；45015 → 结构化诊断。 */
  async send(
    actor: ActorLike,
    input: { botId?: string; appId?: string; toUser?: string; text?: string },
  ): Promise<WechatMpSendResult> {
    const toUser = String(input.toUser ?? '').trim();
    const text = String(input.text ?? '');
    if (!toUser) throw new WechatMpError(422, 'ETOUSER', 'toUser（粉丝 openid）不能为空');
    if (!text.trim()) throw new WechatMpError(422, 'ETEXT', 'text 不能为空');

    let bot: typeof wechatMpBots.$inferSelect | undefined;
    if (input.botId) {
      [bot] = await this.db.select().from(wechatMpBots).where(eq(wechatMpBots.id, input.botId)).limit(1);
    } else if (input.appId) {
      [bot] = await this.db
        .select()
        .from(wechatMpBots)
        .where(and(eq(wechatMpBots.orgId, 'default'), eq(wechatMpBots.appId, String(input.appId))))
        .limit(1);
    }
    if (!bot) throw new WechatMpError(404, 'ENOENT', '公众号接入不存在');
    if (!bot.enabled) throw new WechatMpError(409, 'EDISABLED', '公众号接入已停用');
    const bound = ((bot.allowUserIds as string[]) ?? []).includes(actor.userId);
    if (!bound && actor.role !== 'sys_admin') {
      throw new WechatMpError(403, 'EFORBIDDEN', '未绑定该公众号，无权经其发送客服消息');
    }

    const client = this.clientFor(bot);
    const chunks = chunkWechatText(text);
    for (const chunk of chunks) {
      try {
        await client.sendText(toUser, chunk);
      } catch (error) {
        if (error instanceof WechatApiError) {
          const diag = mapWechatSendDiag(error.errcode, error.errmsg);
          return { ok: false, errcode: error.errcode, errmsg: error.errmsg, diag };
        }
        throw error;
      }
    }
    return { ok: true, chunks: chunks.length };
  }

  private clientFor(bot: typeof wechatMpBots.$inferSelect): WechatMpApiClient {
    let client = this.clients.get(bot.id);
    if (!client) {
      client = this.clientFactory({
        appId: bot.appId,
        appSecret: this.box.decrypt(bot.appSecretEnc),
      });
      this.clients.set(bot.id, client);
    }
    return client;
  }

  // -------------------------------------------------------------------------
  // 24h 暂存清理 + 热队列回落（60s 节流）
  // -------------------------------------------------------------------------

  private async sweepIfDue(): Promise<void> {
    const now = this.now();
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    await this.db
      .delete(wechatMpPending)
      .where(lt(wechatMpPending.createdAt, new Date(now - PENDING_TTL_MS)));
    // 热队列里超过在线窗口 2 倍无人认领的消息回落 DB，避免进程内存独占未投递消息
    const staleBefore = now - ONLINE_WINDOW_MS * 2;
    for (const [uid, q] of this.hotQueue) {
      const keep: WechatMpMessagePayload[] = [];
      for (const p of q) {
        if (p.receivedAt < staleBefore) {
          await this.db.insert(wechatMpPending).values({ botId: p.botId, payload: p });
        } else {
          keep.push(p);
        }
      }
      if (keep.length > 0) this.hotQueue.set(uid, keep);
      else this.hotQueue.delete(uid);
    }
  }
}
