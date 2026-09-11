/**
 * 与桌面端 shared DiagInfo 同构的五类诊断（服务端不依赖桌面 shared 包，
 * 逐字段对齐：kind | message | rawCode）。
 */
export interface WechatDiag {
  kind: 'network' | 'credential' | 'permission' | 'publish' | 'unknown';
  message: string;
  rawCode?: string;
}

/**
 * Module 04 微信公众号出站客户端（T54.9, FR-IM-12, SPEC §3.4）：
 * 稳定凭证 cgi-bin/token（access_token 缓存 7200s，留刷新余量）+
 * 客服消息 cgi-bin/message/custom/send。
 *
 * 窗口规则（research §微信）：用户发消息 → 48h 内最多 5 条；超窗报 45015，
 * 结构化诊断后静默丢弃（不得抛到 5s 被动回复路径）。文本上限 2048 字节
 * （UTF-8），超限由 chunkWechatText 分片后逐条发送。
 *
 * fetch 可注入（镜像 channels 测试的 fetchImpl 桩），单测不触网。
 */

/** Minimal structural fetch so tests can stub; real Response satisfies it. */
export type WechatFetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const WECHAT_MP_TEXT_MAX_BYTES = 2048;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const WECHAT_MP_API_BASE = 'https://api.weixin.qq.com';

export class WechatApiError extends Error {
  constructor(
    public readonly errcode: number,
    public readonly errmsg: string,
  ) {
    super(`微信 API 错误 ${errcode}: ${errmsg}`);
    this.name = 'WechatApiError';
  }
}

/**
 * 发送类错误 → 结构化诊断（对齐 shared DiagInfo 五类，rawCode 保留平台码）。
 *  45015（48h/5 条窗口外）→ permission：需用户重新向公众号发一条消息开窗；
 *  40001/40125/41004/42001（凭证/token）→ credential；
 *  45009/45011（接口配额/频率）→ publish（平台侧限制，非本端配置问题）；
 *  其余 → unknown。
 */
export function mapWechatSendDiag(errcode: number, errmsg: string): WechatDiag {
  const rawCode = String(errcode);
  if (errcode === 45015) {
    return {
      kind: 'permission',
      message: '客服回复窗口已关闭（微信 48 小时/5 条限制），用户重新给公众号发一条消息后可恢复',
      rawCode,
    };
  }
  if ([40001, 40125, 41004, 42001].includes(errcode)) {
    return {
      kind: 'credential',
      message: '公众号凭证无效或 access_token 失效（微信 40001/42001），请在管理台核对 AppSecret',
      rawCode,
    };
  }
  if (errcode === 45009 || errcode === 45011) {
    return {
      kind: 'publish',
      message: '公众号接口调用配额/频率受限（微信 45009/45011），请稍后重试',
      rawCode,
    };
  }
  return { kind: 'unknown', message: `微信客服消息发送失败：${errmsg || rawCode}`, rawCode };
}

/** UTF-8 安全切分到 ≤maxBytes 字节（不劈码点；优先换行/段界；保证逐字还原）。 */
function cutUtf8Safe(buffer: Buffer, maxBytes: number): number {
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return end;
}

export function chunkWechatText(text: string, maxBytes: number = WECHAT_MP_TEXT_MAX_BYTES): string[] {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length === 0) return [];
  if (buffer.length <= maxBytes) return [text];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    if (remaining <= maxBytes) {
      chunks.push(buffer.subarray(offset).toString('utf8'));
      break;
    }
    const window = buffer.subarray(offset, offset + maxBytes + 1);
    let cut = -1;
    const paraBreak = window.lastIndexOf('\n\n', maxBytes - 1);
    if (paraBreak > 0) {
      cut = paraBreak + 2;
    } else {
      const lineBreak = window.lastIndexOf('\n', maxBytes - 1);
      if (lineBreak > 0) cut = lineBreak + 1;
    }
    if (cut <= 0) cut = cutUtf8Safe(window, maxBytes);
    chunks.push(buffer.subarray(offset, offset + cut).toString('utf8').replace(/\n+$/, ''));
    offset += cut;
  }
  return chunks.filter((chunk, index) => chunk.length > 0 || index === 0);
}

export interface WechatMpApiClientOptions {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  fetchImpl?: WechatFetchLike;
}

/**
 * 单个公众号的出站 API 客户端。access_token 按 appId 缓存在实例内
 * （WechatMpService 为每个 bot 持有一个实例 → 缓存生命周期即 bot 生命周期）。
 */
export class WechatMpApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: WechatFetchLike;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: WechatMpApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? WECHAT_MP_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private async requestJson(url: string, init?: Parameters<WechatFetchLike>[1]): Promise<Record<string, unknown>> {
    let payload: unknown;
    try {
      const response = await this.fetchImpl(url, init);
      payload = await response.json();
    } catch {
      throw new WechatApiError(-1, '网络错误：无法连接微信 API（api.weixin.qq.com）');
    }
    return (payload ?? {}) as Record<string, unknown>;
  }

  /** 稳定凭证：GET cgi-bin/token，缓存 expires_in − 5min 余量。 */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now) return this.cachedToken.value;
    const url =
      `${this.baseUrl}/cgi-bin/token?grant_type=client_credential` +
      `&appid=${encodeURIComponent(this.options.appId)}` +
      `&secret=${encodeURIComponent(this.options.appSecret)}`;
    const payload = await this.requestJson(url);
    const token = payload.access_token;
    if (typeof token !== 'string' || token.length === 0) {
      const errcode = Number(payload.errcode ?? 0);
      const errmsg = String(payload.errmsg ?? '获取 access_token 失败');
      if (errcode === 40001 || errcode === 40125 || errcode === 41004) {
        throw new WechatApiError(errcode, errmsg); // AppSecret 错 → 让调用方拿到原始码
      }
      throw new WechatApiError(errcode || -1, errmsg);
    }
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 7200;
    this.cachedToken = { value: token, expiresAt: Date.now() + expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS };
    return token;
  }

  /** 测试兜底：token 被平台判失效（42001/40001 回包）时强制重取一次。 */
  invalidateToken(): void {
    this.cachedToken = null;
  }

  /** 客服消息（文本）：POST cgi-bin/message/custom/send?access_token=.. */
  async sendText(toUser: string, content: string): Promise<void> {
    await this.sendTextOnce(toUser, content, true);
  }

  private async sendTextOnce(toUser: string, content: string, allowRetry: boolean): Promise<void> {
    const token = await this.getAccessToken();
    const payload = await this.requestJson(
      `${this.baseUrl}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ touser: toUser, msgtype: 'text', text: { content } }),
      },
    );
    const errcode = Number(payload.errcode ?? 0);
    if (errcode === 0) return;
    // token 中途被平台吊销 → 失效缓存后重试一次（仅一次，防循环）。
    if ((errcode === 40001 || errcode === 42001) && allowRetry) {
      this.invalidateToken();
      await this.sendTextOnce(toUser, content, false);
      return;
    }
    throw new WechatApiError(errcode, String(payload.errmsg ?? ''));
  }
}
