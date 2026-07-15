import { describe, expect, it, beforeAll } from 'vitest';
import crypto from 'crypto';

// crypto.ts resolves ENCRYPTION_KEY at module load, so set a fixed 64-hex key
// (the documented `openssl rand -hex 32` shape) BEFORE importing it.
const KEY_HEX = '0'.repeat(64).replace(/.{2}/g, 'ab'); // 64 hex chars, deterministic
let encrypt: (t: string) => string;
let decrypt: (t: string) => string;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = KEY_HEX;
  const mod = await import('./crypto');
  encrypt = mod.encrypt;
  decrypt = mod.decrypt;
});

// Reproduce the LEGACY (pre-GCM) AES-256-CBC format `iv:ciphertextHex` so we can
// prove old stored secrets still decrypt.
function legacyCbcEncrypt(text: string): string {
  const key = Buffer.from(KEY_HEX, 'hex');
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  return iv.toString('hex') + ':' + c.update(text, 'utf8', 'hex') + c.final('hex');
}

describe('crypto', () => {
  const secret = 'ghp_' + 'x'.repeat(36);

  it('GCM round-trips and produces the versioned format', () => {
    const enc = encrypt(secret);
    expect(enc.startsWith('v2:')).toBe(true);
    expect(enc.split(':')).toHaveLength(4); // v2:iv:tag:ct
    expect(decrypt(enc)).toBe(secret);
  });

  it('still decrypts legacy AES-256-CBC ciphertext (backward compatible)', () => {
    expect(decrypt(legacyCbcEncrypt(secret))).toBe(secret);
  });

  it('rejects tampered GCM ciphertext (authenticated)', () => {
    const enc = encrypt(secret);
    const tampered = enc.slice(0, -2) + (enc.endsWith('ff') ? '00' : 'ff');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('two encryptions of the same value differ (random IV)', () => {
    expect(encrypt(secret)).not.toBe(encrypt(secret));
  });
});
