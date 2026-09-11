import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * 服务端静态密钥加密盒（Module 05 知识库，SPEC §4 安全设计）：
 * AES-256-GCM，随机 12 字节 IV + 16 字节 auth tag，密文格式
 *   v1.<iv-b64url>.<ciphertext-b64url>.<tag-b64url>
 *
 * 主密钥来源（按优先级）：
 *   1. 环境变量 SERVER_ENCRYPTION_KEY（任意非空字符串，sha256 归一为 256 位；
 *      生产环境建议独立设置，便于与 JWT_SECRET 分开轮换）
 *   2. 未设置时从 JWT_SECRET 派生（dev 便利；派生域分隔避免跨用途重用）。
 * 密钥永不出服务端；明文仅在创建瞬间与 bootstrap TLS 下发时出现。
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static fromKeyMaterial(material: string): SecretBox {
    if (!material) throw new Error('SecretBox: key material must be non-empty');
    return new SecretBox(createHash('sha256').update(material).digest());
  }

  /** bootstrap() 组装：SERVER_ENCRYPTION_KEY 优先，否则由 JWT_SECRET 派生。 */
  static forServer(serverEncryptionKey: string | undefined, jwtSecret: string): SecretBox {
    return SecretBox.fromKeyMaterial(serverEncryptionKey || `laboflow:secret-box:v1:${jwtSecret}`);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
  }

  decrypt(enc: string): string {
    const [v, ivB64, ctB64, tagB64] = enc.split('.');
    if (v !== 'v1' || !ivB64 || !ctB64 || !tagB64) throw new KbSecretError('密文格式不识别');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new KbSecretError('密文校验失败（密钥不匹配或已损坏）');
    }
  }

  /** 解密取尾 4 位用于列表打码展示；解密失败不抛出（打码为 ****）。 */
  safeTail(enc: string | null): string {
    if (!enc) return '';
    try {
      const plain = this.decrypt(enc);
      return plain.slice(-4);
    } catch {
      return '****';
    }
  }
}

export class KbSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KbSecretError';
  }
}
