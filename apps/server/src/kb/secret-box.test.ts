import { describe, it, expect } from 'vitest';
import { SecretBox, KbSecretError } from './secret-box.js';

/** Module 05：静态密钥加密盒（AES-256-GCM）——纯单测，不依赖 DB。 */
describe('SecretBox (AES-256-GCM)', () => {
  it('round-trips plaintext and hides it at rest', () => {
    const box = SecretBox.fromKeyMaterial('test-master-key');
    const plain = 'sk-weknora-9f8e7d6c';
    const enc = box.encrypt(plain);
    expect(enc).not.toContain(plain);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(box.decrypt(enc)).toBe(plain);
  });

  it('same plaintext encrypts to different ciphertext (random IV)', () => {
    const box = SecretBox.fromKeyMaterial('k');
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('different key material cannot decrypt (tamper/wrong-key → throws)', () => {
    const enc = SecretBox.fromKeyMaterial('key-a').encrypt('secret');
    expect(() => SecretBox.fromKeyMaterial('key-b').decrypt(enc)).toThrow(KbSecretError);
  });

  it('rejects malformed payloads', () => {
    expect(() => SecretBox.fromKeyMaterial('k').decrypt('not-a-box')).toThrow(KbSecretError);
  });

  it('safeTail returns last4 and never throws', () => {
    const box = SecretBox.fromKeyMaterial('k');
    expect(box.safeTail(box.encrypt('sk-abcdef1234'))).toBe('1234');
    expect(box.safeTail(null)).toBe('');
    expect(box.safeTail('garbage')).toBe('****');
  });

  it('forServer prefers SERVER_ENCRYPTION_KEY and falls back to jwtSecret derivation', () => {
    const a = SecretBox.forServer('explicit-key', 'jwt-dev-secret');
    const b = SecretBox.forServer(undefined, 'jwt-dev-secret');
    const c = SecretBox.forServer(undefined, 'other-jwt-secret');
    const enc = b.encrypt('x');
    expect(b.decrypt(enc)).toBe('x');
    // 显式 key 与 jwtSecret 派生互不通用；不同 jwtSecret 派生不同 key
    expect(() => a.decrypt(enc)).toThrow(KbSecretError);
    expect(() => c.decrypt(enc)).toThrow(KbSecretError);
  });
});
