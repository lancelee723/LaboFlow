import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Module 04 微信公众号中继 — 回调验签 + 消息加解密（T54.7, FR-IM-11, SPEC §2.2/§3.4）。
 *
 * 微信公众平台消息协议（research/2026-09-11-IM平台机器人API调研.md §微信）：
 *  - URL 验签（GET）：signature = sha1(sort(token, timestamp, nonce) join '')，
 *    校验通过原样返回 echostr。
 *  - 消息体（POST）：XML。明文模式直接携带业务字段；安全模式整个 XML 只有
 *    <Encrypt><![CDATA[..]]></Encrypt>，此时附加 msg_signature =
 *    sha1(sort(token, timestamp, nonce, encrypt))，密文解开后才是业务 XML。
 *  - 消息密文（安全模式）：EncodingAESKey（43 字符）+'=' base64 解码得 32 字节
 *    AES-256-CBC 密钥，IV = 密钥前 16 字节，PKCS#7 填充；明文布局
 *      random(16B) + msg_len(4B 大端) + msg_xml + receiveId(=appid)。
 *
 * 本文件保持零依赖（node:crypto only）+ 纯函数，方便单测直接覆盖。
 */

/** sha1 over the sorted-joined parts — both GET 验签 and POST msg_signature. */
export function wechatSignature(parts: Array<string | undefined>): string {
  return createHash('sha1')
    .update(parts.filter((p): p is string => typeof p === 'string').sort().join(''))
    .digest('hex');
}

export interface WechatSignatureInput {
  token: string;
  timestamp?: string;
  nonce?: string;
  /** GET 验签为 signature；安全模式 POST 为 msg_signature（同一算法，多拼 encrypt）。 */
  signature?: string;
  /** 安全模式密文（base64）；提供时参与签名计算。 */
  encrypt?: string;
}

/** 常数时间比较防时序侧信道（token 比对属于秘密材料）。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** GET echostr 验签 / POST msg_signature 验签。 */
export function verifyWechatSignature(input: WechatSignatureInput): boolean {
  if (!input.signature || !input.timestamp || !input.nonce) return false;
  const expected = wechatSignature([input.token, input.timestamp, input.nonce, input.encrypt]);
  return safeEqual(expected, input.signature);
}

/** EncodingAESKey（43 字符）→ 32 字节 AES 密钥（官方协议：尾补 '=' 后 base64 解码）。 */
export function aesKeyFromEncodingAesKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey}=`, 'base64');
  if (key.length !== 32) throw new WechatCryptoError('EncodingAESKey 非法（解码后须为 32 字节）');
  return key;
}

export class WechatCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WechatCryptoError';
  }
}

/**
 * 解开一条安全模式消息密文。明文布局见文件头；node 的 aes-256-cbc
 * 默认开启 PKCS#7 去填充（final() 校验），失败视为密文损坏。
 */
export function decryptWechatMessage(
  encryptedBase64: string,
  encodingAesKey: string,
): { xml: string; receiveId: string } {
  let data: Buffer;
  try {
    data = Buffer.from(encryptedBase64, 'base64');
  } catch {
    throw new WechatCryptoError('消息密文不是合法 base64');
  }
  if (data.length < 33) throw new WechatCryptoError('消息密文过短'); // 16 random + 4 len + ≥1 xml + ≥1 appid
  const key = aesKeyFromEncodingAesKey(encodingAesKey);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    plain = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new WechatCryptoError('消息密文解密失败（EncodingAESKey 不匹配或密文损坏）');
  }
  if (plain.length < 20) throw new WechatCryptoError('解密后明文过短');
  const msgLen = plain.readUInt32BE(16);
  if (20 + msgLen > plain.length) throw new WechatCryptoError('明文长度字段越界');
  return {
    xml: plain.subarray(20, 20 + msgLen).toString('utf8'),
    receiveId: plain.subarray(20 + msgLen).toString('utf8'),
  };
}

/** decryptWechatMessage 的逆运算（单测构造样本 / 调试工具用；服务端不做被动回复）。 */
export function encryptWechatMessage(
  xml: string,
  encodingAesKey: string,
  receiveId: string,
): string {
  const key = aesKeyFromEncodingAesKey(encodingAesKey);
  const msg = Buffer.from(xml, 'utf8');
  const head = Buffer.alloc(20); // 16B random + 4B msg_len
  randomBytes(16).copy(head, 0);
  head.writeUInt32BE(msg.length, 16);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  const plain = Buffer.concat([head, msg, Buffer.from(receiveId, 'utf8')]);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

export interface WechatXmlMessage {
  /** 逐字段平铺；公众号回调只用到 ToUserName/FromUserName/CreateTime/MsgType/Content/MsgId/Encrypt。 */
  fields: Record<string, string>;
}

/**
 * 极简命名空间容忍的 XML 解析（不引入依赖）：匹配
 * `<Tag><![CDATA[值]]></Tag>` 或 `<Tag>纯文本</Tag>`，平铺进 fields。
 * 公众号回调 XML 无嵌套同名标签，平铺语义足够（SPEC §3.4 只取 6 个字段）。
 */
export function parseWechatXml(xml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re = /<([A-Za-z][A-Za-z0-9_.:-]*)\s*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const value = m[2] !== undefined ? m[2] : (m[3] ?? '');
    fields[m[1]!] = value;
  }
  return fields;
}
