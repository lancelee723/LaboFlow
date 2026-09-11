/**
 * WeCom 智能机器人 (WeCom intelligent bot) channel adapter — SPEC §3.3.
 *
 * Platform facts (research doc 2026-09-11, §2.B):
 *   - Long connection `wss://openws.work.weixin.qq.com`, BotID + Secret auth
 *     frame, single connection (a new subscription kicks the old one), ~30s
 *     ping, no public IP and no message encryption required.
 *   - Inbound: text / mixed / quote messages (single chat + group @bot);
 *     voice arrives pre-transcribed as text.
 *   - Outbound: `markdown` content ≤ 20480 bytes per message;
 *     `template_card` for status cards; stream chunks must finish ≤ 10min;
 *     active sends are allowed within 24h of the user's last message;
 *     30 msg/min per conversation rate limit.
 *   - Files ≤ 20MB via aibot_upload_media_init/chunk/finish (media_id valid
 *     3 days) — v1 does not send files (OutboundPayload has no files yet).
 *
 * PROTOCOL COVERAGE (honest):
 *   - Auth frame `{type:"auth", botId, secret}` and the ~30s ping cadence are
 *     implemented per the documented protocol. The WSS client itself uses the
 *     WHATWG WebSocket built into Node/Electron (no npm dependency needed).
 *   - The exact wire names of the reply frames (`aibot_send_msg` markdown /
 *     template_card / stream) are NOT fully pinned down in the public docs we
 *     verified; the outbound frame builders below implement the documented
 *     payload pieces (markdown ≤20480B chunking, template_card shape) behind
 *     a swappable `sendFrame` seam and carry TODO markers with doc links so
 *     the frame names can be confirmed against a live tenant:
 *     https://developer.work.weixin.qq.com/document/ (智能机器人 → 回调/发送消息).
 *   - Inbound normalization is tolerant to the documented field variants
 *     (chattype "single"/"group", from.userid, text.content / mixed parts).
 *
 * NOTE: keep this file runtime-import-free (node builtins only) so plain-node
 * tests can load it directly; `@pi-desktop/shared` and local files are
 * `import type` only.
 */

import { randomUUID } from "node:crypto";

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

const WECOM_MARKDOWN_MAX_BYTES = 20480;
const WECOM_FILE_MAX_BYTES = 20 * 1024 * 1024;
const WECOM_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const WECOM_PING_INTERVAL_MS = 30_000;

export const WECOM_CAPABILITIES: ChannelCapabilities = {
  maxTextBytes: WECOM_MARKDOWN_MAX_BYTES,
  fileMaxBytes: WECOM_FILE_MAX_BYTES,
  streaming: true,
  card: true,
  replyWindowMs: WECOM_REPLY_WINDOW_MS,
};

export const WECOM_WSS_URL = "wss://openws.work.weixin.qq.com";

// ---------------------------------------------------------------------------
// Protocol frame builders (pure, unit-tested)
// ---------------------------------------------------------------------------

/** Documented connection auth: first frame after the socket opens. */
export function buildWecomAuthFrame(botId: string, secret: string): string {
  return JSON.stringify({ type: "auth", botId, secret });
}

/** ~30s keepalive ping (single connection; new subscription kicks the old). */
export function buildWecomPingFrame(): string {
  return JSON.stringify({ type: "ping" });
}

/** UTF-8-safe cut at or before `maxBytes`, never splitting a code point. */
function cutUtf8Safe(buffer: Buffer, maxBytes: number): number {
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

/**
 * Split markdown into ≤20480-byte (UTF-8) chunks, preferring paragraph
 * boundaries (`\n\n`), then line breaks, then a hard cut.
 */
export function chunkWecomMarkdown(
  text: string,
  maxBytes: number = WECOM_MARKDOWN_MAX_BYTES,
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
    // Prefer the last paragraph break, else the last newline, else hard cut.
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

/**
 * Outbound markdown frame.
 *
 * TODO(protocol): the smart-bot reply wire format — whether active replies
 * ride the same WSS connection as `aibot_send_msg` frames or a REST call —
 * needs confirmation against the official docs / a live tenant. The payload
 * shape below follows the documented message body (msgtype markdown, content
 * ≤20480B); the frame `type` is our best current reading.
 * Doc: https://developer.work.weixin.qq.com/document/ (智能机器人 API 模式).
 */
export function buildWecomMarkdownFrame(input: {
  chatRef: string;
  content: string;
  msgId?: string;
}): string {
  return JSON.stringify({
    type: "aibot_send_msg",
    payload: {
      chatid: input.chatRef,
      msgid: input.msgId ?? randomUUID(),
      msgtype: "markdown",
      markdown: { content: input.content },
    },
  });
}

/** template_card status card frame (text_notice), same TODO as markdown. */
export function buildWecomTemplateCardFrame(input: {
  chatRef: string;
  title: string;
  status: string;
  detail?: string;
  msgId?: string;
}): string {
  return JSON.stringify({
    type: "aibot_send_msg",
    payload: {
      chatid: input.chatRef,
      msgid: input.msgId ?? randomUUID(),
      msgtype: "template_card",
      template_card: {
        card_type: "text_notice",
        source: { desc: "LaboFlow" },
        main_title: { title: input.title },
        ...(input.detail ? { sub_title_text: `${input.status}\n${input.detail}` } : { sub_title_text: input.status }),
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Ping loop (injectable interval so tests can run and stop deterministically)
// ---------------------------------------------------------------------------

export interface WecomPingLoop {
  stop(): void;
}

export function createWecomPingLoop(
  send: (frame: string) => void,
  intervalMs: number = WECOM_PING_INTERVAL_MS,
  schedule: (cb: () => void, ms: number) => () => void = (cb, ms) => {
    const timer = setTimeout(cb, ms);
    return () => clearTimeout(timer);
  },
): WecomPingLoop {
  let cancelled = false;
  let cancelTimer: (() => void) | null = null;
  function tick(): void {
    if (cancelled) return;
    send(buildWecomPingFrame());
    cancelTimer = schedule(tick, intervalMs);
  }
  cancelTimer = schedule(tick, intervalMs);
  return {
    stop() {
      cancelled = true;
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Inbound normalization (tolerant to documented field variants)
// ---------------------------------------------------------------------------

/** Type alias for the raw callback frame; shapes are not fully pinned down. */
export type WecomRawFrame = Record<string, unknown>;

export interface WecomParsedFrame {
  msgId: string;
  chatRef: string;
  chatType: "p2p" | "group";
  senderRef: string;
  text: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pick(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

/**
 * Strip a leading group @bot mention (`@BotName `), which the platform keeps
 * in the text content for group chats.
 */
export function stripWecomGroupMention(text: string): string {
  return text.replace(/^@\S+\s*/, "").trim();
}

/**
 * Normalize one smart-bot callback frame. Handles the documented variants:
 * `chattype` "single" → p2p / "group" → group; sender under
 * `from.userid`; text under `text.content`; mixed messages carry
 * `mixed.msg_item[].text.content` (voice arrives pre-transcribed as text).
 */
export function normalizeWecomFrame(
  frame: WecomRawFrame,
  channelId: string,
): WecomParsedFrame | null {
  const payload = (pick(frame, "payload", "msg", "event") ?? frame) as Record<string, unknown>;

  const chatRef = str(pick(payload, "chatid", "chatId", "chat_id"));
  const msgId = str(pick(payload, "msgid", "msgId", "msg_id", "message_id"));
  if (!chatRef) return null;

  const chatTypeRaw = str(pick(payload, "chattype", "chatType", "chat_type")).toLowerCase();
  const chatType: "p2p" | "group" =
    chatTypeRaw === "group" || chatTypeRaw === "room" ? "group" : "p2p";

  const from = pick(payload, "from", "sender");
  const senderRef = str(pick(from, "userid", "userId", "user_id", "open_userid"));

  let text = "";
  const msgType = str(pick(payload, "msgtype", "msgType", "msg_type")).toLowerCase();
  if (msgType === "mixed") {
    const items = pick(pick(payload, "mixed"), "msg_item");
    if (Array.isArray(items)) {
      text = items
        .map((item) => str(pick(pick(item, "text"), "content")))
        .filter((part) => part.length > 0)
        .join(" ");
    }
  } else {
    const textObj = pick(payload, "text");
    text = str(pick(textObj, "content")) || str(pick(payload, "text"));
  }
  text = text.trim();

  // Voice arrives pre-transcribed; quote messages may carry a quoted prefix —
  // both are treated as plain text (SPEC §3.3).
  return { msgId, chatRef, chatType, senderRef, text };
}

// ---------------------------------------------------------------------------
// WSS transport (built-in WHATWG WebSocket; injectable socket for tests)
// ---------------------------------------------------------------------------

export interface WecomSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ): void;
}

export interface WecomWsTransportOptions {
  botId: string;
  secret: string;
  url?: string;
  pingIntervalMs?: number;
  /** Socket factory seam; defaults to the built-in WebSocket client. */
  socketFactory?: (url: string) => WecomSocket;
  onFrame?: (frame: Record<string, unknown>) => void;
  onState?: (state: ChannelState, diag?: DiagInfo) => void;
  logger?: ChannelLogger;
}

export class WecomWsTransport {
  private options: WecomWsTransportOptions;
  private socket: WecomSocket | null = null;
  private ping: WecomPingLoop | null = null;
  private pingedFrames: string[] = []; // test observability only

  constructor(options: WecomWsTransportOptions) {
    this.options = options;
  }

  /** Frames sent over the socket (kept for tests/diagnostics). */
  get sentFrames(): string[] {
    return this.pingedFrames;
  }

  /** Push one protocol frame over the live socket (no-op when closed). */
  sendFrame(frame: string): void {
    this.pingedFrames.push(frame);
    this.socket?.send(frame);
  }

  async connect(): Promise<void> {
    const url = this.options.url ?? WECOM_WSS_URL;
    const factory =
      this.options.socketFactory ??
      ((socketUrl: string) => new WebSocket(socketUrl) as unknown as WecomSocket);
    this.options.onState?.("connecting");

    const socket = factory(url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.addEventListener("open", () => {
        // Documented auth: BotID + Secret frame immediately after open.
        this.sendFrame(buildWecomAuthFrame(this.options.botId, this.options.secret));
      });
      socket.addEventListener("message", (event) => {
        let frame: Record<string, unknown> | null = null;
        try {
          frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          frame = null;
        }
        if (frame) this.options.onFrame?.(frame);
        if (!settled) {
          // TODO(protocol): the success/failure ack frame names are not in the
          // verified docs; v1 treats the first server frame as ready.
          settled = true;
          resolve();
        }
      });
      socket.addEventListener("close", () => {
        this.stopPing();
        this.options.onState?.("disconnected");
        if (!settled) {
          settled = true;
          reject(
            createDiagError({
              kind: "network",
              message: "企微长连接在鉴权完成前关闭",
            }),
          );
        }
      });
      socket.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          reject(
            createDiagError({
              kind: "network",
              message: `无法连接 ${url}，请检查网络或代理设置`,
            }),
          );
        }
      });
    });

    this.ping = createWecomPingLoop(
      (frame) => this.sendFrame(frame),
      this.options.pingIntervalMs,
    );
  }

  private stopPing(): void {
    this.ping?.stop();
    this.ping = null;
  }

  async disconnect(): Promise<void> {
    this.stopPing();
    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
    this.socket = null;
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface WecomAdapterOptions {
  url?: string;
  pingIntervalMs?: number;
  socketFactory?: (url: string) => WecomSocket;
  logger?: ChannelLogger;
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

export function createWecomAdapter(
  channelId: string,
  options: WecomAdapterOptions = {},
): ChannelAdapter & { test(account: ChannelAccount): Promise<DiagInfo | null> } {
  let messageCb: ((message: InboundMessage) => void) | null = null;
  let stateCb: ((state: ChannelState, diag?: DiagInfo) => void) | null = null;
  let transport: WecomWsTransport | null = null;

  function dispatchFrame(frame: WecomRawFrame): void {
    const parsed = normalizeWecomFrame(frame, channelId);
    if (!parsed || parsed.text.length === 0) return;
    let text = parsed.text;
    if (parsed.chatType === "group") text = stripWecomGroupMention(text);
    const message: InboundMessage = {
      channelId,
      provider: "wecom",
      senderRef: parsed.senderRef,
      chatRef: parsed.chatRef,
      chatType: parsed.chatType,
      text,
      raw: frame,
      receivedAt: Date.now(),
    };
    messageCb?.(message);
  }

  return {
    provider: "wecom",
    capabilities: WECOM_CAPABILITIES,

    onMessage(cb) {
      messageCb = cb;
    },

    onState(cb) {
      stateCb = cb;
    },

    async connect(account: ChannelAccount) {
      const botId = pickCredential(account.credentials, ["bot_id", "botId"]);
      const secret = pickCredential(account.credentials, ["secret", "bot_secret"]);
      if (!botId || !secret) {
        const diag: DiagInfo = {
          kind: "credential",
          message: "缺少 BotID / Secret，请先在卡片中粘贴凭证",
        };
        stateCb?.("error", diag);
        throw createDiagError(diag);
      }
      transport = new WecomWsTransport({
        botId,
        secret,
        url: options.url,
        pingIntervalMs: options.pingIntervalMs,
        socketFactory: options.socketFactory,
        onFrame: dispatchFrame,
        onState: (state, diag) => stateCb?.(state, diag),
        logger: options.logger,
      });
      try {
        await transport.connect();
        stateCb?.("connected");
      } catch (error) {
        const diag = diagFromError(error);
        stateCb?.("error", diag);
        throw error;
      }
    },

    async disconnect() {
      await transport?.disconnect().catch(() => undefined);
      transport = null;
      stateCb?.("disconnected");
    },

    /**
     * Send markdown (chunked to ≤20480B) or the template_card status card.
     * TODO(protocol): frame names pending live-tenant confirmation — see the
     * builders' doc links above.
     */
    async send(chatRef: string, payload: OutboundPayload) {
      if (!transport) {
        throw createDiagError({
          kind: "unknown",
          message: "通道未连接，无法发送消息",
        });
      }
      if (payload.statusCard) {
        transport.sendFrame(
          buildWecomTemplateCardFrame({
            chatRef,
            title: payload.statusCard.title,
            status: payload.statusCard.status,
            detail: payload.statusCard.detail,
          }),
        );
        return;
      }
      const chunks = chunkWecomMarkdown(payload.replyText);
      for (const chunk of chunks) {
        transport.sendFrame(buildWecomMarkdownFrame({ chatRef, content: chunk }));
      }
    },

    async test(account: ChannelAccount) {
      // No documented lightweight REST ping for smart bots; credential shape
      // check only — the real handshake happens in connect().
      const botId = pickCredential(account.credentials, ["bot_id", "botId"]);
      const secret = pickCredential(account.credentials, ["secret", "bot_secret"]);
      if (!botId || !secret) {
        return {
          kind: "credential",
          message: "缺少 BotID / Secret",
        } as DiagInfo;
      }
      return null;
    },
  };
}

export function createWecomAdapterFactory(
  options: WecomAdapterOptions = {},
): (channelId: string) => ChannelAdapter {
  return (channelId: string) => createWecomAdapter(channelId, options);
}
