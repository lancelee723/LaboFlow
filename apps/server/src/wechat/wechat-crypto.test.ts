import { describe, it, expect } from 'vitest';

import {
  aesKeyFromEncodingAesKey,
  decryptWechatMessage,
  encryptWechatMessage,
  parseWechatXml,
  verifyWechatSignature,
  wechatSignature,
  WechatCryptoError,
} from './wechat-crypto.js';
import { MsgIdDeduper } from './wechat-mp.service.js';

/**
 * Module 04 公众号中继 —— 纯加密/协议单测（T54.7）：
 * GET 验签（有效/无效 token）、安全模式 AES-256-CBC(PKCS7) 加解密回环、
 * 极简 XML 解析（CDATA/明文混合）、MsgId LRU 去重。
 */

const AES_KEY_43 = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'; // 43 位字母数字（26+10+7）
const TOKEN = 'laboflow-token';
const TS = '1348831860';
const NONCE = 'abc123';

describe('微信公众号验签（GET echostr / POST msg_signature 同算法）', () => {
  it('有效 token → 验签通过', () => {
    const signature = wechatSignature([TOKEN, TS, NONCE]);
    expect(
      verifyWechatSignature({ token: TOKEN, timestamp: TS, nonce: NONCE, signature }),
    ).toBe(true);
  });

  it('无效 token / 篡改参数 → 验签拒绝', () => {
    const signature = wechatSignature([TOKEN, TS, NONCE]);
    expect(
      verifyWechatSignature({ token: 'wrong-token', timestamp: TS, nonce: NONCE, signature }),
    ).toBe(false);
    expect(
      verifyWechatSignature({ token: TOKEN, timestamp: '999', nonce: NONCE, signature }),
    ).toBe(false);
    expect(
      verifyWechatSignature({ token: TOKEN, timestamp: TS, nonce: NONCE, signature: '' }),
    ).toBe(false);
  });

  it('安全模式：encrypt 参与签名（msg_signature）', () => {
    const encrypt = 'ENCRYPTED-BLOB';
    const msgSignature = wechatSignature([TOKEN, TS, NONCE, encrypt]);
    expect(
      verifyWechatSignature({ token: TOKEN, timestamp: TS, nonce: NONCE, signature: msgSignature, encrypt }),
    ).toBe(true);
    // 缺 encrypt 参与或换了密文都应失败
    expect(
      verifyWechatSignature({ token: TOKEN, timestamp: TS, nonce: NONCE, signature: msgSignature }),
    ).toBe(false);
    expect(
      verifyWechatSignature({ token: TOKEN, timestamp: TS, nonce: NONCE, signature: msgSignature, encrypt: 'OTHER' }),
    ).toBe(false);
  });

  it('sha1(sort(parts) join)：与手工排序一致', () => {
    // nonce < token < timestamp 的字典序场景
    const s = wechatSignature(['zzz', 'aaa', 'mmm']);
    expect(s).toBe(wechatSignature(['aaa', 'mmm', 'zzz']));
    expect(s).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('安全模式消息加解密（EncodingAESKey AES-256-CBC PKCS7）', () => {
  const INNER_XML =
    '<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[oABC]]></FromUserName>' +
    '<CreateTime>1348831860</CreateTime><MsgType><![CDATA[text]]></MsgType>' +
    '<Content><![CDATA[帮我跑个测试]]></Content><MsgId>1234567890123456</MsgId></xml>';
  const RECEIVE_ID = 'wx1234567890abcdef';

  it('加解密回环：xml/receiveId 逐字还原', () => {
    const encrypted = encryptWechatMessage(INNER_XML, AES_KEY_43, RECEIVE_ID);
    const dec = decryptWechatMessage(encrypted, AES_KEY_43);
    expect(dec.xml).toBe(INNER_XML);
    expect(dec.receiveId).toBe(RECEIVE_ID);
  });

  it('长内容（>2 密文块）回环不劈码点', () => {
    const longXml = `<xml><Content><![CDATA[${'汉'.repeat(500)}]]></Content></xml>`;
    const dec = decryptWechatMessage(encryptWechatMessage(longXml, AES_KEY_43, RECEIVE_ID), AES_KEY_43);
    expect(dec.xml).toBe(longXml);
  });

  it('错误 EncodingAESKey → 解密失败抛可读错误', () => {
    const encrypted = encryptWechatMessage(INNER_XML, AES_KEY_43, RECEIVE_ID);
    const otherKey = 'ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkj'; // 另一把合法 43 位钥匙
    expect(() => decryptWechatMessage(encrypted, otherKey)).toThrow(WechatCryptoError);
  });

  it('非法 EncodingAESKey（解码非 32 字节）直接拒绝', () => {
    expect(() => aesKeyFromEncodingAesKey('tooshort')).toThrow(WechatCryptoError);
    expect(Buffer.from(aesKeyFromEncodingAesKey(AES_KEY_43)).length).toBe(32);
  });

  it('密文过短/非 base64 → 拒绝', () => {
    expect(() => decryptWechatMessage('!!!not-base64!!!', AES_KEY_43)).toThrow(WechatCryptoError);
    expect(() => decryptWechatMessage(Buffer.from('short').toString('base64'), AES_KEY_43)).toThrow(WechatCryptoError);
  });
});

describe('极简 XML 解析（命名空间容忍、CDATA/明文）', () => {
  it('解析官方回调样例（全 CDATA）', () => {
    const xml =
      '<xml><ToUserName><![CDATA[gh_test]]></ToUserName>' +
      '<FromUserName><![CDATA[oABC]]></FromUserName>' +
      '<CreateTime>1348831860</CreateTime>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content><![CDATA[this is a test]]></Content>' +
      '<MsgId>1234567890123456</MsgId></xml>';
    const fields = parseWechatXml(xml);
    expect(fields.ToUserName).toBe('gh_test');
    expect(fields.FromUserName).toBe('oABC');
    expect(fields.CreateTime).toBe('1348831860');
    expect(fields.MsgType).toBe('text');
    expect(fields.Content).toBe('this is a test');
    expect(fields.MsgId).toBe('1234567890123456');
  });

  it('明文数字节点与 CDATA 混排、值内含 XML 特殊字符', () => {
    const xml = '<xml><Count>3</Count><Content><![CDATA[<xml>转义 & 原文]]></Content></xml>';
    const fields = parseWechatXml(xml);
    expect(fields.Count).toBe('3');
    expect(fields.Content).toBe('<xml>转义 & 原文');
  });

  it('安全模式外层：只有 Encrypt 字段', () => {
    const xml = '<xml><ToUserName><![CDATA[gh_test]]></ToUserName><Encrypt><![CDATA[BLOB==]]></Encrypt></xml>';
    const fields = parseWechatXml(xml);
    expect(fields.Encrypt).toBe('BLOB==');
    expect(fields.MsgType).toBeUndefined();
  });
});

describe('MsgId LRU 去重（平台 5s 超时重推）', () => {
  it('同一 MsgId 只放行一次', () => {
    const d = new MsgIdDeduper();
    expect(d.check('m1')).toBe(true);
    expect(d.check('m1')).toBe(false);
    expect(d.check('m2')).toBe(true);
  });

  it('容量上限：逐出最旧条目', () => {
    const d = new MsgIdDeduper();
    for (let i = 0; i < 4096; i++) d.check(`m${i}`);
    expect(d.check('m0')).toBe(false); // 仍在窗口内
    d.check('new-one'); // 挤掉 m0
    expect(d.check('m0')).toBe(true);
    expect(d.check('new-one')).toBe(false);
  });
});
