/**
 * WeChat 公众号 (WeChat MP) channel adapter — module 04, SPEC §3.4 中继链路.
 *
 * Unlike feishu/wecom (client-side long connections), the 公众号 callback MUST
 * terminate on a public endpoint, so inbound rides the LaboFlow server relay:
 *
 *   微信 → POST /bots/webhook/wechat（服务端验签/AES 解密/MsgId 去重）
 *        → 在线：服务端内存热队列；离线：wechat_mp_pending 表暂存 ≤24h
 *        → 本适配器每 5s 轮询 GET /org/wechat-mp/pending（JWT，取走即清）
 *        → registry 派发 HeadlessAgentDriver → 完成后
 *        → POST /org/wechat-mp/send（JWT）→ 服务端客服消息 API
 *          （access_token 缓存 7200s；48h/5 条窗口；>2048B 服务端分片兜底）
 *
 * v1 TRANSPORT (documented): poll (5s) instead of WS push — the SPEC §2.2
 * bot.inbound WS frame is the later upgrade; polling reuses the org JWT and
 * needs no extra server push infra.
 *
 * Credentials: this adapter never touches 公众号 appid/secret/aeskey (they
 * live server-side only, SPEC §4). Account credentials = `server_url` of the
 * LaboFlow server (+ optional `bot_id` pin); the org session JWT arrives via
 * the `tokenProvider` factory seam (wired from the org session in index.ts).
 * Inbound normalization: FromUserName → senderRef/chatRef, Content → text.
 *
 * NOTE: keep runtime imports limited to node builtins + `@pi-desktop/shared`
 * so plain-node tests can load this file directly; `@pi-desktop/shared` and
 * local files are `import type` only.
 */

import type {
  ChannelAccount,
  ChannelCapabilities,
  ChannelState,
  DiagInfo,
  InboundMessage,
  OutboundPayload,
} from "@pi-desktop/shared";
import type { ChannelAdapter, ChannelLogger } from "./types";

/** Minimal structural fetch so tests can stub; real Response satisfies it. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Error carrying a DiagInfo; caught by the registry to feed state.error. */
export function createDiagError(diag: DiagInfo): Error & { diag: DiagInfo } {
  const error = new Error(diag.message) as Error & { diag: DiagInfo };
  error.diag = diag;
  return error;
}

export function diagFromError(error: unknown): DiagInfo {
  const diag = (error as { diag?: DiagInfo } | null)?.diag;
  if (diag) return diag;
  return { kind: "unknown", message: String(error) };
}

/** 公众号客服消息文本上限 2048 字节（UTF-8）；文件 v1 不支持（经服务端中继）。 */
export const WECHAT_MP_TEXT_MAX_BYTES = 2048;
/** v1 轮询传输周期（SPEC §2.2 的 WS bot.inbound 帧为后续升级）。 */
export const WECHAT_MP_POLL_INTERVAL_MS = 5_000;
/** 客服消息窗口：用户发消息后 48h 内最多 5 条（超窗服务端报 45015）。 */
export const WECHAT_MP_REPLY_WINDOW_MS = 48 * 60 * 60 * 1000;

export const WECHAT_MP_CAPABILITIES: ChannelCapabilities = {
  maxTextBytes: WECHAT_MP_TEXT_MAX_BYTES,
  fileMaxBytes: 0,
  streaming: false,
  card: false,
  replyWindowMs: WECHAT_MP_REPLY_WINDOW_MS,
};

// ---------------------------------------------------------------------------
// Outbound chunking (≤2048B, UTF-8 safe; mirrors the server-side safety net)
// ---------------------------------------------------------------------------

function cutUtf8Safe(buffer: Uint8Array, maxBytes: number): number {
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return end;
}

/**
 * Split text into ≤2048-byte (UTF-8) chunks, preferring paragraph boundaries
 * (`\n\n`), then line breaks, then a hard cut — never splitting a code point.
 * 客户端先行分片；服务端发送前还会再兜底分片一次（双重保障，幂等）。
 */
export function chunkWechatMpText(
  text: string,
  maxBytes: number = WECHAT_MP_TEXT_MAX_BYTES,
): string[] {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length === 0) return [];
  if (buffer.length <= maxBytes) return [text];

  const chunks: string[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    if (remaining <= maxBytes) {
      chunks.push(buffer.subarray(offset).toString("utf8"));
      break;
    }
    const window = buffer.subarray(offset, offset + maxBytes + 1);
    let cut = -1;
    const paraBreak = window.lastIndexOf("\n\n", maxBytes - 1);
    if (paraBreak > 0) {
      cut = paraBreak + 2;
    } else {
      const lineBreak = window.lastIndexOf("\n", maxBytes - 1);
      if (lineBreak > 0) cut = lineBreak + 1;
    }
    if (cut <= 0) cut = cutUtf8Safe(window, maxBytes);
    chunks.push(buffer.subarray(offset, offset + cut).toString("utf8").replace(/\n+$/, ""));
    offset += cut;
  }
  return chunks.filter((chunk, index) => chunk.length > 0 || index === 0);
}

// ---------------------------------------------------------------------------
// Inbound normalization (relay pending message → InboundMessage)
// ---------------------------------------------------------------------------

/** GET /org/wechat-mp/pending 的消息行（服务端 WechatMpPendingMessage 同构）。 */
export interface WechatMpPendingMessage {
  id: string;
  botId: string;
  appId: string;
  /** 粉丝 openid（=回复目标 toUser）。 */
  fromUser: string;
  msgType: string;
  content: string;
  msgId?: string;
  createTime?: number;
  receivedAt?: number;
}

/** 公众号只有粉丝 ↔ 公众号单聊 → chatType 恒 p2p；非文本类型 v1 忽略。 */
export function normalizeWechatMpPending(
  message: WechatMpPendingMessage,
  channelId: string,
): InboundMessage | null {
  if (!message.fromUser) return null;
  if (message.msgType !== "text") return null;
  return {
    channelId,
    provider: "wechat_mp",
    senderRef: message.fromUser,
    chatRef: message.fromUser,
    chatType: "p2p",
    text: String(message.content ?? "").trim(),
    raw: message,
    receivedAt: message.receivedAt ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Credentials (server_url + optional bot pin; JWT via tokenProvider seam)
// ---------------------------------------------------------------------------

export interface WechatMpCredentials {
  serverUrl: string;
  botId?: string;
}

function pickCredential(
  credentials: Record<string, string> | undefined,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = credentials?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function parseWechatMpCredentials(
  account: ChannelAccount,
  fallbackServerUrl?: string | (() => string | undefined),
): WechatMpCredentials | null {
  const fromAccount = pickCredential(account.credentials, ["server_url", "serverUrl"]);
  const raw =
    fromAccount ??
    (typeof fallbackServerUrl === "function" ? fallbackServerUrl() : fallbackServerUrl);
  if (!raw || !raw.trim()) return null;
  const botId = pickCredential(account.credentials, ["bot_id", "botId"]);
  return {
    serverUrl: raw.trim().replace(/\/+$/, ""),
    ...(botId ? { botId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface WechatMpAdapterOptions {
  /**
   * 组织会话 JWT 提供方（工厂缝：index.ts 用 org session 注入；令牌过期由
   * 调用方刷新）。中继凭证不含 JWT 本体。
   */
  tokenProvider: () => Promise<string>;
  /** API base 兜底（账号凭证 server_url 优先；可为 getter，连接时求值）。 */
  serverUrl?: string | (() => string | undefined);
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  /** 可注入定时器（默认 setTimeout；测试手动驱动后无残留 timer）。 */
  schedule?: (cb: () => void, ms: number) => () => void;
  logger?: ChannelLogger;
}

export function createWechatMpAdapter(
  channelId: string,
  options: WechatMpAdapterOptions,
): ChannelAdapter & {
  /** 立即执行一轮轮询（测试/手动刷新）。 */
  pollOnce(): Promise<void>;
  test(account: ChannelAccount): Promise<DiagInfo | null>;
} {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const schedule =
    options.schedule ??
    ((cb: () => void, ms: number) => {
      const timer = setTimeout(cb, ms);
      return () => clearTimeout(timer);
    });
  const pollIntervalMs = options.pollIntervalMs ?? WECHAT_MP_POLL_INTERVAL_MS;

  let messageCb: ((message: InboundMessage) => void) | null = null;
  let stateCb: ((state: ChannelState, diag?: DiagInfo) => void) | null = null;
  let credentials: WechatMpCredentials | null = null;
  let cancelTimer: (() => void) | null = null;
  let connected = false;
  let polling = false;
  let consecutiveFailures = 0;
  let degraded = false;
  /** chatRef(openid) → 出站路由提示（botId / appId，来自最近一条入站消息）。 */
  const routeByChat = new Map<string, { botId?: string; appId?: string }>();

  function emitState(state: ChannelState, diag?: DiagInfo): void {
    stateCb?.(state, diag);
  }

  function markHealthy(): void {
    consecutiveFailures = 0;
    if (degraded) {
      degraded = false;
      emitState("connected");
    }
  }

  function markDegraded(diag: DiagInfo): void {
    degraded = true;
    emitState("error", diag);
  }

  async function authedFetch(
    credentials: WechatMpCredentials,
    path: string,
    init?: Parameters<FetchLike>[1],
  ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
    const token = await options.tokenProvider();
    return fetchImpl(`${credentials.serverUrl}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    });
  }

  async function pollOnce(): Promise<void> {
    if (!credentials || polling) return;
    polling = true;
    try {
      const response = await authedFetch(credentials, "/org/wechat-mp/pending");
      if (response.status === 401 || response.status === 403) {
        markDegraded({
          kind: "credential",
          message: "组织会话令牌无效或未绑定公众号（401），请先在组织设置登录",
        });
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { messages?: WechatMpPendingMessage[] };
      for (const message of payload.messages ?? []) {
        routeByChat.set(message.fromUser, { botId: message.botId, appId: message.appId });
        const inbound = normalizeWechatMpPending(message, channelId);
        if (inbound && inbound.text) messageCb?.(inbound);
      }
      markHealthy();
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3 && !degraded) {
        markDegraded({
          kind: "network",
          message: `无法连接中继服务器（${String(error)}），请检查网络或服务器地址`,
        });
      }
      options.logger?.app("channels", "warn", "wechat_mp poll failed", {
        data: { channelId, error: String(error) },
      });
    } finally {
      polling = false;
    }
  }

  function startLoop(): void {
    stopLoop();
    const tick = (): void => {
      if (!connected) return;
      void pollOnce();
      cancelTimer = schedule(tick, pollIntervalMs);
    };
    cancelTimer = schedule(tick, 0); // 首轮立即
  }

  function stopLoop(): void {
    cancelTimer?.();
    cancelTimer = null;
  }

  return {
    provider: "wechat_mp",
    capabilities: WECHAT_MP_CAPABILITIES,

    onMessage(cb) {
      messageCb = cb;
    },

    onState(cb) {
      stateCb = cb;
    },

    async connect(account: ChannelAccount) {
      const parsed = parseWechatMpCredentials(account, options.serverUrl);
      if (!parsed) {
        const diag: DiagInfo = {
          kind: "credential",
          message: "缺少服务器地址（server_url），请先在卡片中填写 LaboFlow 服务器",
        };
        emitState("error", diag);
        throw createDiagError(diag);
      }
      credentials = parsed;
      connected = true;
      degraded = false;
      consecutiveFailures = 0;
      startLoop(); // 首轮立即轮询（也承担连接体检：连续 3 次失败 → error 态）
    },

    async disconnect() {
      stopLoop();
      connected = false;
      credentials = null;
      routeByChat.clear();
      emitState("disconnected");
    },

    /**
     * 出站：文本按 ≤2048B 分片逐条 POST /org/wechat-mp/send；路由提示取该
     * openid 最近一条入站消息的 botId/appId（服务端客服消息按 bot 凭证发送）。
     * statusCard 以纯文本转写（公众号 v1 不发卡片，capabilities.card=false）。
     */
    async send(chatRef: string, payload: OutboundPayload) {
      if (!credentials || !connected) {
        throw createDiagError({ kind: "unknown", message: "通道未连接，无法发送消息" });
      }
      const route = routeByChat.get(chatRef) ?? {};
      const bodyText = payload.statusCard
        ? `【${payload.statusCard.title}】${payload.statusCard.status}${payload.statusCard.detail ? `\n${payload.statusCard.detail}` : ""}`
        : payload.replyText;
      for (const chunk of chunkWechatMpText(bodyText)) {
        const response = await authedFetch(credentials, "/org/wechat-mp/send", {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            ...(route.botId ? { botId: route.botId } : {}),
            ...(route.appId ? { appId: route.appId } : {}),
            toUser: chatRef,
            text: chunk,
          }),
        });
        const result = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          diag?: DiagInfo;
          errcode?: number;
          errmsg?: string;
          message?: string;
        };
        if (!response.ok) {
          throw createDiagError({
            kind: response.status === 403 ? "permission" : "unknown",
            message: result.message ?? `中继出站失败（HTTP ${response.status}）`,
          });
        }
        if (result.ok === false) {
          throw createDiagError(
            result.diag ?? {
              kind: "unknown",
              message: result.errmsg ?? "客服消息发送失败",
              ...(result.errcode !== undefined ? { rawCode: String(result.errcode) } : {}),
            },
          );
        }
      }
    },

    /** 连接体检（FR-IM-03）：凭证形状 + 一次真实 pending 轮询。 */
    async test(account: ChannelAccount) {
      const parsed = parseWechatMpCredentials(account);
      if (!parsed) {
        return { kind: "credential", message: "缺少服务器地址（server_url）" } as DiagInfo;
      }
      try {
        const response = await authedFetch(parsed, "/org/wechat-mp/pending");
        if (response.status === 401 || response.status === 403) {
          return {
            kind: "credential",
            message: "组织会话令牌无效（401），请重新登录组织",
          } as DiagInfo;
        }
        if (!response.ok) {
          return {
            kind: "unknown",
            message: `中继服务器返回 HTTP ${response.status}`,
          } as DiagInfo;
        }
        return null;
      } catch {
        return {
          kind: "network",
          message: `无法连接 ${parsed.serverUrl}，请检查网络或服务器地址`,
        } as DiagInfo;
      }
    },

    pollOnce,
  };
}

export function createWechatMpAdapterFactory(
  options: WechatMpAdapterOptions,
): (channelId: string) => ChannelAdapter {
  return (channelId: string) => createWechatMpAdapter(channelId, options);
}
