/**
 * Feishu (飞书) channel adapter — module 04, SPEC §3.2.
 *
 * Platform facts (docs/laboflow/phase5/research/2026-09-11-IM平台机器人API调研.md):
 *   - Inbound: event `im.message.receive_v1`; `message.content` is a JSON
 *     STRING that needs a second parse; group messages arrive with inline
 *     `<at user_id="...">Name</at>` mention tags to strip; dedup by
 *     `message_id` (the platform re-pushes on timeout/retry).
 *   - Outbound: `POST /open-apis/im/v1/messages?receive_id_type=chat_id`
 *     with `uuid` idempotency; auth via `tenant_access_token`
 *     (app_id + app_secret, 2h validity).
 *   - Limits: text 150KB, files ≤30MB (file_key via im/v1/files — v1 does not
 *     send files), 5 QPS/user.
 *
 * TRANSPORT STATUS (honest):
 *   - The official WebSocket long connection needs `@larksuiteoapi/node-sdk`,
 *     which we cannot add as an npm dependency here. `createFeishuWssPendingTransport`
 *     is a documented seam whose connect() always fails with a DiagInfo.
 *   - `FeishuWebhookTransport` is FULLY implemented (public HTTP callback
 *     protocol: URL-verification challenge echo, Verification-Token check,
 *     v2.0 `{"encrypt": ...}` AES-256-CBC envelope when an encrypt key is
 *     configured, message_id LRU dedup). An org that can expose a local
 *     relay can run this mode end-to-end today, and it keeps the adapter
 *     testable without a live tenant.
 *   - The REST send path is fully implemented over injectable fetch.
 *
 * Error mapping (SPEC §3.2): 10014 / 99991663 → credential;
 * 99991672 → permission; publish-shaped messages → publish; fetch failures →
 * network; anything else → unknown.
 *
 * NOTE: keep this file runtime-import-free (node builtins only) so plain-node
 * tests can load it directly; `@pi-desktop/shared` and local files are
 * `import type` only.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

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

const FEISHU_TEXT_MAX_BYTES = 150 * 1024;
const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024;

export const FEISHU_CAPABILITIES: ChannelCapabilities = {
  maxTextBytes: FEISHU_TEXT_MAX_BYTES,
  fileMaxBytes: FEISHU_FILE_MAX_BYTES,
  streaming: false,
  card: true,
};

// ---------------------------------------------------------------------------
// Diagnostics mapping (SPEC §3.2 诊断映射)
// ---------------------------------------------------------------------------

const FEISHU_ERROR_DIAG: Record<string, { kind: DiagInfo["kind"]; message: string }> = {
  // app_id / app_secret invalid
  "10014": {
    kind: "credential",
    message: "app_id 或 app_secret 无效（飞书 10014），请重新粘贴凭证",
  },
  // tenant_access_token rejected
  "99991663": {
    kind: "credential",
    message: "tenant_access_token 被拒绝，凭证无效或已被撤销（飞书 99991663）",
  },
  // app lacks the required API scope
  "99991672": {
    kind: "permission",
    message:
      "应用缺少所需 API 权限（scope），请在飞书开发者后台开通 im:message 相关权限并重新发布（飞书 99991672）",
  },
};

/** Map a Feishu API error (code + msg) or a thrown error to a DiagInfo. */
export function mapFeishuDiag(
  code?: number | string,
  message?: string,
): DiagInfo {
  const rawCode = code === undefined ? undefined : String(code);
  if (rawCode && FEISHU_ERROR_DIAG[rawCode]) {
    return { ...FEISHU_ERROR_DIAG[rawCode], rawCode };
  }
  const text = `${message ?? ""}`;
  if (/permission|scope|forbidden|无权|权限/i.test(text)) {
    return {
      kind: "permission",
      message: "应用缺少所需权限（scope），请补齐权限并重新发布版本",
      rawCode,
    };
  }
  if (/not published|app unavailable|available scope|app not exist|未发布|上架|可用范围/i.test(text)) {
    return {
      kind: "publish",
      message: "应用未发布或调用者不在可用范围内，请发布版本并检查可用范围",
      rawCode,
    };
  }
  if (/token/i.test(text) && /invalid|expired|无效|过期/i.test(text)) {
    return { kind: "credential", message: "凭证无效或已过期", rawCode };
  }
  return {
    kind: "unknown",
    message: text || "飞书接口返回未知错误",
    rawCode,
  };
}

function networkDiag(error: unknown): DiagInfo {
  return {
    kind: "network",
    message: "无法连接飞书开放平台，请检查网络或代理设置",
  };
}

// ---------------------------------------------------------------------------
// REST client (token + send) — fully implemented over injectable fetch.
// ---------------------------------------------------------------------------

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface FeishuRestClient {
  getTenantAccessToken(): Promise<string>;
  sendMessage(input: {
    chatId: string;
    msgType: "text" | "interactive";
    content: Record<string, unknown>;
    uuid?: string;
  }): Promise<{ messageId?: string }>;
  /** Health check: acquires a token (network + credential). */
  testConnection(): Promise<DiagInfo | null>;
}

export interface FeishuRestOptions {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export function createFeishuRestClient(options: FeishuRestOptions): FeishuRestClient {
  const baseUrl = (options.baseUrl ?? "https://open.feishu.cn").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  let cachedToken: { value: string; expiresAt: number } | null = null;

  async function requestJson(
    url: string,
    init?: Parameters<FetchLike>[1],
  ): Promise<Record<string, unknown>> {
    let payload: unknown;
    try {
      const response = await fetchImpl(url, init);
      payload = await response.json();
    } catch (error) {
      throw createDiagError(networkDiag(error));
    }
    return (payload ?? {}) as Record<string, unknown>;
  }

  async function getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAt > now) return cachedToken.value;
    const payload = await requestJson(
      `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: options.appId,
          app_secret: options.appSecret,
        }),
      },
    );
    const token = payload.tenant_access_token;
    if (typeof token !== "string" || token.length === 0) {
      throw createDiagError(
        mapFeishuDiag(payload.code as number | undefined, String(payload.msg ?? "")),
      );
    }
    const expire = typeof payload.expire === "number" ? payload.expire : 7200;
    cachedToken = {
      value: token,
      expiresAt: Date.now() + expire * 1000 - TOKEN_REFRESH_MARGIN_MS,
    };
    return token;
  }

  return {
    getTenantAccessToken,

    async sendMessage({ chatId, msgType, content, uuid }) {
      const token = await getTenantAccessToken();
      const payload = await requestJson(
        `${baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            receive_id: chatId,
            msg_type: msgType,
            content: JSON.stringify(content),
            // uuid param = platform idempotency key for retries.
            uuid: uuid ?? randomUUID(),
          }),
        },
      );
      if (payload.code !== 0) {
        throw createDiagError(
          mapFeishuDiag(payload.code as number | undefined, String(payload.msg ?? "")),
        );
      }
      const data = payload.data as { message_id?: string } | undefined;
      return { messageId: data?.message_id };
    },

    async testConnection() {
      try {
        await getTenantAccessToken();
        return null;
      } catch (error) {
        return diagFromError(error);
      }
    },
  };
}

/** UTF-8-safe truncation to `maxBytes` (never splits a code point). */
export function truncateUtf8Safe(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return `${buffer.subarray(0, end).toString("utf8")}…`;
}

/** Interactive card for OutboundPayload.statusCard (title/status/detail). */
export function buildStatusCardContent(payload: {
  title: string;
  status: string;
  detail?: string;
}): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "div",
      text: { tag: "lark_md", content: `**状态**：${payload.status}` },
    },
  ];
  if (payload.detail) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: payload.detail },
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: payload.title },
      template: "blue",
    },
    elements,
  };
}

// ---------------------------------------------------------------------------
// Inbound event normalization (im.message.receive_v1)
// ---------------------------------------------------------------------------

export interface FeishuRawEvent {
  header?: {
    event_type?: string;
    token?: string;
    event_id?: string;
    tenant_key?: string;
  };
  event?: {
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      /** JSON string per platform contract — requires a second parse. */
      content?: string;
    };
    sender?: {
      sender_id?: { open_id?: string; union_id?: string; user_id?: string };
    };
  };
  /** v1.0 legacy shape fallback. */
  type?: string;
  token?: string;
}

/** Strip inline `<at user_id="...">Name</at>` mention tags and trim. */
export function stripFeishuMentions(text: string): string {
  return text
    .replace(/<at[^>]*>[\s\S]*?<\/at>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Second parse of `message.content` (a JSON string) into plain text. */
export function parseFeishuContentText(
  messageType: string | undefined,
  contentJson: string | undefined,
): string {
  if (!contentJson) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return "";
  }
  if (messageType === "text") {
    const text = (parsed as { text?: unknown })?.text;
    return typeof text === "string" ? text : "";
  }
  if (messageType === "post") {
    // Rich text: {title?, content: [[{tag, text?}, ...], ...]}
    const post = parsed as { content?: Array<Array<{ tag?: string; text?: string }>> };
    const lines = post.content ?? [];
    return lines
      .map((line) =>
        line
          .map((node) => (node.tag === "text" || node.tag === "a" ? node.text ?? "" : ""))
          .join(""),
      )
      .join("\n")
      .trim();
  }
  return "";
}

function normalizeFeishuEvent(raw: FeishuRawEvent, channelId: string): InboundMessage | null {
  const message = raw.event?.message;
  if (!message?.message_id || !message.chat_id) return null;
  const chatType = message.chat_type === "group" ? "group" : "p2p";
  let text = parseFeishuContentText(message.message_type, message.content);
  if (chatType === "group") text = stripFeishuMentions(text);
  return {
    channelId,
    provider: "feishu",
    senderRef: raw.event?.sender?.sender_id?.open_id ?? "",
    chatRef: message.chat_id,
    chatType,
    text: text.trim(),
    raw,
    receivedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Webhook transport (fully implemented HTTP callback mode)
// ---------------------------------------------------------------------------

export interface WebhookReply {
  status: number;
  body: Record<string, unknown>;
}

const DEDUP_LRU_MAX = 1024;

export class FeishuWebhookTransport {
  private verificationToken?: string;
  private encryptKey?: string;
  private seenIds = new Set<string>();
  private onEvent: (message: InboundMessage) => void;
  private channelId: string;
  private logger?: ChannelLogger;

  constructor(options: {
    channelId: string;
    verificationToken?: string;
    encryptKey?: string;
    onEvent: (message: InboundMessage) => void;
    logger?: ChannelLogger;
  }) {
    this.channelId = options.channelId;
    this.verificationToken = options.verificationToken;
    this.encryptKey = options.encryptKey;
    this.onEvent = options.onEvent;
    this.logger = options.logger;
  }

  /** Feishu encrypt scheme: key = sha256(encryptKey), IV = first 16 bytes. */
  static decrypt(encrypt: string, encryptKey: string): string {
    const key = createHash("sha256").update(encryptKey, "utf8").digest();
    const data = Buffer.from(encrypt, "base64");
    if (data.length <= 16) throw new Error("encrypted payload too short");
    const decipher = createDecipheriv("aes-256-cbc", key, data.subarray(0, 16));
    const plain = Buffer.concat([
      decipher.update(data.subarray(16)),
      decipher.final(), // validates + strips PKCS#7 padding
    ]);
    return plain.toString("utf8");
  }

  /** Inverse of `decrypt`; exported for tests and relay-side tooling. */
  static encrypt(plain: string, encryptKey: string): string {
    const key = createHash("sha256").update(encryptKey, "utf8").digest();
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, encrypted]).toString("base64");
  }

  /** message_id LRU: platform re-pushes must yield exactly one dispatch. */
  private shouldProcess(id: string): boolean {
    if (this.seenIds.has(id)) return false;
    if (this.seenIds.size >= DEDUP_LRU_MAX) {
      const oldest = this.seenIds.values().next().value;
      if (oldest !== undefined) this.seenIds.delete(oldest);
    }
    this.seenIds.add(id);
    return true;
  }

  private tokenOk(token: string | undefined): boolean {
    if (!this.verificationToken) return true;
    return token === this.verificationToken;
  }

  /** Handle one HTTP callback body (already JSON-parsed or raw string). */
  async handle(body: unknown): Promise<WebhookReply> {
    let parsed: Record<string, unknown> | null = null;
    if (typeof body === "string") {
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return { status: 400, body: { code: 400, msg: "invalid json" } };
      }
    } else if (body && typeof body === "object") {
      parsed = body as Record<string, unknown>;
    }
    if (!parsed) return { status: 400, body: { code: 400, msg: "invalid body" } };

    // v2.0 envelope: {"encrypt": "<base64>"} — decrypt when key configured.
    if (typeof parsed.encrypt === "string") {
      if (!this.encryptKey) {
        return {
          status: 401,
          body: { code: 401, msg: "encrypted event but no encrypt key configured" },
        };
      }
      try {
        parsed = JSON.parse(
          FeishuWebhookTransport.decrypt(parsed.encrypt, this.encryptKey),
        ) as Record<string, unknown>;
      } catch (error) {
        return {
          status: 401,
          body: { code: 401, msg: `decrypt failed: ${String(error)}` },
        };
      }
    }

    const header = parsed.header as FeishuRawEvent["header"] | undefined;
    const token = (header?.token ?? parsed.token) as string | undefined;

    if (parsed.type === "url_verification" || header?.event_type === "url_verification") {
      if (!this.tokenOk(token)) {
        return { status: 403, body: { code: 403, msg: "verification token mismatch" } };
      }
      const challenge = parsed.challenge;
      return {
        status: 200,
        body: { challenge: typeof challenge === "string" ? challenge : "" },
      };
    }

    if (!this.tokenOk(token)) {
      return { status: 403, body: { code: 403, msg: "verification token mismatch" } };
    }

    const raw = parsed as unknown as FeishuRawEvent;
    const message = normalizeFeishuEvent(raw, this.channelId);
    if (!message) {
      // Non-message event (card callbacks etc.): ACK and ignore.
      return { status: 200, body: { code: 0 } };
    }
    const dedupId = raw.event?.message?.message_id ?? header?.event_id ?? "";
    if (dedupId && !this.shouldProcess(dedupId)) {
      this.logger?.app("channels", "info", "feishu duplicate event dropped", {
        data: { messageId: dedupId },
      });
      return { status: 200, body: { code: 0 } };
    }
    try {
      this.onEvent(message);
    } catch (error) {
      // ACK anyway — the platform re-pushes on timeout; dedup protects us.
      this.logger?.app("channels", "warn", "feishu event dispatch failed", {
        data: String(error),
      });
    }
    return { status: 200, body: { code: 0 } };
  }
}

// ---------------------------------------------------------------------------
// WSS transport seam (official SDK pending)
// ---------------------------------------------------------------------------

export interface FeishuTransport {
  mode: "wss" | "webhook";
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  webhook?: FeishuWebhookTransport;
}

/**
 * Placeholder for the official WebSocket long connection
 * (`@larksuiteoapi/node-sdk` WsClient — cannot be added as a dependency in
 * this pass). connect() always fails with a diagnosable error so the
 * registry surfaces an honest state instead of a silent hang.
 */
export function createFeishuWssPendingTransport(): FeishuTransport {
  return {
    mode: "wss",
    async connect() {
      throw createDiagError({
        kind: "unknown",
        message: "wss endpoint requires official SDK transport (pending)",
      });
    },
    async disconnect() {},
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface FeishuAdapterOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** "wss" (default, pending SDK) or "webhook" (fully implemented). */
  mode?: "wss" | "webhook";
  logger?: ChannelLogger;
}

interface FeishuCredentials {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
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

export function parseFeishuCredentials(
  account: ChannelAccount,
): FeishuCredentials | null {
  const appId = pickCredential(account.credentials, ["app_id", "appId"]);
  const appSecret = pickCredential(account.credentials, ["app_secret", "appSecret"]);
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    verificationToken: pickCredential(account.credentials, [
      "verification_token",
      "verificationToken",
    ]),
    encryptKey: pickCredential(account.credentials, ["encrypt_key", "encryptKey"]),
  };
}

export function createFeishuAdapter(
  channelId: string,
  options: FeishuAdapterOptions = {},
): ChannelAdapter & {
  handleWebhook(body: unknown): Promise<WebhookReply>;
  test(account: ChannelAccount): Promise<DiagInfo | null>;
} {
  const mode = options.mode ?? "wss";
  let messageCb: ((message: InboundMessage) => void) | null = null;
  let stateCb: ((state: ChannelState, diag?: DiagInfo) => void) | null = null;
  let rest: FeishuRestClient | null = null;
  let transport: FeishuTransport | null = null;
  let connected = false;

  function emitState(state: ChannelState, diag?: DiagInfo): void {
    stateCb?.(state, diag);
  }

  return {
    provider: "feishu",
    capabilities: FEISHU_CAPABILITIES,

    onMessage(cb) {
      messageCb = cb;
    },

    onState(cb) {
      stateCb = cb;
    },

    async connect(account) {
      const credentials = parseFeishuCredentials(account);
      if (!credentials) {
        const diag: DiagInfo = {
          kind: "credential",
          message: "缺少 app_id / app_secret，请先在卡片中粘贴凭证",
        };
        emitState("error", diag);
        throw createDiagError(diag);
      }
      rest = createFeishuRestClient({
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        baseUrl: options.baseUrl,
        fetchImpl: options.fetchImpl,
      });

      if (mode === "webhook") {
        transport = {
          mode: "webhook",
          connect: async () => undefined,
          disconnect: async () => undefined,
          webhook: new FeishuWebhookTransport({
            channelId,
            verificationToken: credentials.verificationToken,
            encryptKey: credentials.encryptKey,
            onEvent: (message) => messageCb?.(message),
            logger: options.logger,
          }),
        };
        connected = true;
        emitState("connected");
        return;
      }

      transport = createFeishuWssPendingTransport();
      try {
        await transport.connect();
        connected = true;
        emitState("connected");
      } catch (error) {
        const diag = diagFromError(error);
        emitState("error", diag);
        throw error;
      }
    },

    async disconnect() {
      transport?.disconnect().catch(() => undefined);
      transport = null;
      rest = null;
      connected = false;
      emitState("disconnected");
    },

    async send(chatRef, payload: OutboundPayload) {
      if (!rest) throw createDiagError({
        kind: "unknown",
        message: "通道未连接，无法发送消息",
      });
      if (payload.statusCard) {
        await rest.sendMessage({
          chatId: chatRef,
          msgType: "interactive",
          content: buildStatusCardContent(payload.statusCard),
        });
        return;
      }
      const text = truncateUtf8Safe(payload.replyText, FEISHU_TEXT_MAX_BYTES);
      await rest.sendMessage({
        chatId: chatRef,
        msgType: "text",
        content: { text },
      });
    },

    async test(account: ChannelAccount) {
      // Health check runs against the hydrated credentials, independent of
      // connect(): network reachability + credential validity (token grant).
      const credentials = parseFeishuCredentials(account);
      if (!credentials) {
        return { kind: "credential", message: "缺少 app_id / app_secret" } as DiagInfo;
      }
      const client = createFeishuRestClient({
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        baseUrl: options.baseUrl,
        fetchImpl: options.fetchImpl,
      });
      return client.testConnection();
    },

    /** HTTP relay entry point for webhook mode (SPEC §3.1 备选路线). */
    handleWebhook(body: unknown): Promise<WebhookReply> {
      const webhook = transport?.mode === "webhook" ? transport.webhook : undefined;
      if (!webhook || !connected) {
        return Promise.resolve({
          status: 409,
          body: { code: 409, msg: "webhook transport not connected" },
        });
      }
      return webhook.handle(body);
    },
  };
}

export interface FeishuAdapterFactoryOptions extends FeishuAdapterOptions {}

export function createFeishuAdapterFactory(
  options: FeishuAdapterFactoryOptions = {},
): (channelId: string) => ChannelAdapter {
  return (channelId: string) => createFeishuAdapter(channelId, options);
}
