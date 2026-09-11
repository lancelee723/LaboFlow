import { describe, it, expect } from 'vitest';

import {
  chunkWechatText,
  mapWechatSendDiag,
  WechatApiError,
  WechatMpApiClient,
  type WechatFetchLike,
} from './wechat-mp.client.js';

/**
 * Module 04 公众号出站客户端单测（T54.9, FR-IM-12）：
 * 注入 fetch 桩（镜像 channels 测试的 fetchImpl 注入），覆盖
 * access_token 获取与缓存、客服消息 body、>2048B 分片、45015 超窗诊断。
 */

interface StubCall {
  url: string;
  method?: string;
  body?: string;
}

function makeWechatStub(sendErrcode = 0): { calls: StubCall[]; fetchImpl: WechatFetchLike } {
  const calls: StubCall[] = [];
  const fetchImpl: WechatFetchLike = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body });
    if (url.includes('/cgi-bin/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'ACCESS-TOKEN', expires_in: 7200 }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => (sendErrcode === 0 ? { errcode: 0, errmsg: 'ok' } : { errcode: sendErrcode, errmsg: 'reply out of range' }),
    };
  };
  return { calls, fetchImpl };
}

const client = (stub: { fetchImpl: WechatFetchLike }) =>
  new WechatMpApiClient({ appId: 'wx123', appSecret: 'sec', fetchImpl: stub.fetchImpl });

describe('access_token 稳定获取与缓存（cgi-bin/token, 7200s）', () => {
  it('首次取 token，缓存期内复用（两次发送只取一次 token）', async () => {
    const stub = makeWechatStub();
    const c = client(stub);
    await c.sendText('oABC', '第一条');
    await c.sendText('oABC', '第二条');
    const tokenCalls = stub.calls.filter((c2) => c2.url.includes('/cgi-bin/token'));
    expect(tokenCalls.length).toBe(1);
    expect(tokenCalls[0]!.url).toContain('appid=wx123');
    expect(tokenCalls[0]!.url).toContain('secret=sec');
    expect(tokenCalls[0]!.url).toContain('grant_type=client_credential');
    const sends = stub.calls.filter((c2) => c2.url.includes('/cgi-bin/message/custom/send'));
    expect(sends.length).toBe(2);
    expect(sends[0]!.url).toContain('access_token=ACCESS-TOKEN');
  });

  it('token 中途失效（40001）→ 失效缓存重取并重试一次', async () => {
    const calls: StubCall[] = [];
    let tokenCount = 0;
    const fetchImpl: WechatFetchLike = async (url, init = {}) => {
      calls.push({ url, method: init.method, body: init.body });
      if (url.includes('/cgi-bin/token')) {
        tokenCount += 1;
        return { ok: true, status: 200, json: async () => ({ access_token: `AT-${tokenCount}`, expires_in: 7200 }) };
      }
      const stale = url.includes('access_token=AT-1');
      return { ok: true, status: 200, json: async () => (stale ? { errcode: 42001, errmsg: 'access_token expired' } : { errcode: 0, errmsg: 'ok' }) };
    };
    const c = new WechatMpApiClient({ appId: 'wx123', appSecret: 'sec', fetchImpl });
    await c.sendText('oABC', 'hi');
    expect(tokenCount).toBe(2);
    const sendCalls = calls.filter((c2) => c2.url.includes('/cgi-bin/message/custom/send'));
    expect(sendCalls.length).toBe(2);
    expect(sendCalls[1]!.url).toContain('access_token=AT-2');
  });

  it('AppSecret 错误（40001 on token）→ 抛 WechatApiError', async () => {
    const fetchImpl: WechatFetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 40001, errmsg: 'invalid credential' }),
    });
    const c = new WechatMpApiClient({ appId: 'wx123', appSecret: 'bad', fetchImpl });
    await expect(c.sendText('oABC', 'hi')).rejects.toBeInstanceOf(WechatApiError);
  });
});

describe('客服消息发送（cgi-bin/message/custom/send）', () => {
  it('body 形如 {touser, msgtype:text, text:{content}}', async () => {
    const stub = makeWechatStub();
    await client(stub).sendText('oABC', '你好');
    const send = stub.calls.find((c) => c.url.includes('/cgi-bin/message/custom/send'))!;
    expect(send.method).toBe('POST');
    expect(JSON.parse(send.body!)).toEqual({ touser: 'oABC', msgtype: 'text', text: { content: '你好' } });
  });

  it('网络失败 → 结构化 WechatApiError（errcode=-1）', async () => {
    const fetchImpl: WechatFetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const c = new WechatMpApiClient({ appId: 'wx', appSecret: 's', fetchImpl });
    try {
      await c.sendText('o', 'x');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WechatApiError);
      expect((err as WechatApiError).errcode).toBe(-1);
    }
  });
});

describe('45015 等错误 → 结构化诊断（48h/5 条窗口）', () => {
  it('45015 → permission 诊断，rawCode 保留', () => {
    const diag = mapWechatSendDiag(45015, 'reply out of range');
    expect(diag.kind).toBe('permission');
    expect(diag.rawCode).toBe('45015');
    expect(diag.message).toContain('48');
  });

  it('凭证类 40001/42001 → credential；配额类 45009 → publish；其余 unknown', () => {
    expect(mapWechatSendDiag(40001, 'x').kind).toBe('credential');
    expect(mapWechatSendDiag(42001, 'x').kind).toBe('credential');
    expect(mapWechatSendDiag(45009, 'x').kind).toBe('publish');
    expect(mapWechatSendDiag(99999, 'x').kind).toBe('unknown');
  });

  it('客户端把 45015 以 WechatApiError 抛出（服务层映射为诊断）', async () => {
    const stub = makeWechatStub(45015);
    await expect(client(stub).sendText('oABC', '超窗了')).rejects.toMatchObject({ errcode: 45015 });
  });
});

describe('出站文本分片（≤2048 字节，UTF-8 安全）', () => {
  it('短文本单片段；空文本零片段', () => {
    expect(chunkWechatText('你好')).toEqual(['你好']);
    expect(chunkWechatText('')).toEqual([]);
  });

  it('超长文本切成 ≤2048B 片段且逐字还原', () => {
    const text = 'a'.repeat(6000);
    const chunks = chunkWechatText(text);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(2048);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('多字节内容不劈码点', () => {
    const text = '汉'.repeat(1200); // 3600B
    const chunks = chunkWechatText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(2048);
      expect(chunk.includes('\uFFFD')).toBe(false);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('优先段落/行边界切分', () => {
    const paragraph = 'a'.repeat(1000);
    const text = [paragraph, paragraph, paragraph].join('\n\n');
    const chunks = chunkWechatText(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(`${paragraph}\n\n${paragraph}`); // 前两段整体成片（尾部分隔符剥离）
    expect(chunks[1]).toBe(paragraph);
    expect(chunks.join('\n\n')).toBe(text); // 剥离的只是冗余分隔符，语义逐字还原
  });
});
