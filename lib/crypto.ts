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
const IV_LENGTH = 16;

/**
 * Encrypt a string using AES-256-CBC
 * @param text - Plain text to encrypt
 * @returns Encrypted text with IV (format: iv:encryptedText)
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY.slice(0, 64), 'hex'),
    iv
  );

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt a string encrypted with AES-256-CBC
 * @param text - Encrypted text (format: iv:encryptedText)
 * @returns Decrypted plain text
 */
export function decrypt(text: string): string {
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift()!, 'hex');
  const encryptedText = parts.join(':');

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY.slice(0, 64), 'hex'),
    iv
  );

  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
