import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ALGORITHM = 'aes-256-cbc';

/**
 * Resolve a STABLE encryption key. Order:
 *  1. ENCRYPTION_KEY env (preferred for production).
 *  2. A key file persisted in the data volume — generated once and reused, so
 *     encrypted secrets survive container restarts/redeploys.
 *  3. Ephemeral random key (last resort) with a loud warning.
 * Previously the key was random every start, so any token encrypted before a
 * restart became permanently undecryptable.
 */
function resolveEncryptionKey(): string {
  const fromEnv = process.env.ENCRYPTION_KEY;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const keyPath = path.join(dataDir, '.encryption-key');
  try {
    if (fs.existsSync(keyPath)) {
      const existing = fs.readFileSync(keyPath, 'utf8').trim();
      if (existing.length >= 64) return existing;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyPath, generated, { mode: 0o600 });
    return generated;
  } catch (error) {
    console.warn(
      '[crypto] Could not persist an encryption key; using an ephemeral key. ' +
        'Encrypted secrets will NOT survive a restart — set ENCRYPTION_KEY.',
      error,
    );
    return crypto.randomBytes(32).toString('hex');
  }
}

const ENCRYPTION_KEY = resolveEncryptionKey();
const GCM_ALGORITHM = 'aes-256-gcm';
const GCM_IV_LENGTH = 12;

/**
 * Derive a validated 32-byte key. A 64-hex-char ENCRYPTION_KEY (the documented
 * `openssl rand -hex 32`) is used directly — this matches the legacy
 * `slice(0,64)` derivation, so CBC ciphertext written before this change still
 * decrypts. Any other value (a passphrase / wrong length) is hashed to 32 bytes
 * via SHA-256 instead of silently truncating to a short/garbage key.
 */
function keyBytes(): Buffer {
  const k = ENCRYPTION_KEY.trim();
  if (/^[0-9a-fA-F]{64}$/u.test(k)) return Buffer.from(k, 'hex');
  return crypto.createHash('sha256').update(k, 'utf8').digest();
}
const KEY = keyBytes();
if (!/^[0-9a-fA-F]{64}$/u.test(ENCRYPTION_KEY.trim())) {
  console.warn(
    '[crypto] ENCRYPTION_KEY is not 64 hex chars; deriving the key via SHA-256. ' +
      'Set ENCRYPTION_KEY to `openssl rand -hex 32` for a proper 256-bit key.',
  );
}

/**
 * Encrypt with authenticated AES-256-GCM.
 * @returns `v2:<ivHex>:<tagHex>:<ciphertextHex>` (the `v2` tag distinguishes it
 *          from legacy CBC `iv:ct` for decrypt()).
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv(GCM_ALGORITHM, KEY, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

/**
 * Decrypt a value from encrypt(). Handles both the new authenticated GCM format
 * (`v2:iv:tag:ct`) and legacy unauthenticated CBC (`iv:ct`) so existing stored
 * secrets keep working; re-saving any secret upgrades it to GCM.
 */
export function decrypt(text: string): string {
  if (text.startsWith('v2:')) {
    const [, ivHex, tagHex, ctHex] = text.split(':');
    const decipher = crypto.createDecipheriv(GCM_ALGORITHM, KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(ctHex, 'hex')) + decipher.final('utf8');
  }
  // Legacy AES-256-CBC (`iv:ciphertextHex`).
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift()!, 'hex');
  const encryptedText = parts.join(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY.subarray(0, 32), iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
