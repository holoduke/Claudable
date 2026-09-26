/**
 * Signature part of personal API tokens — runtime-neutral (Web Crypto only), so the
 * proxy can reject a forged token without touching the database.
 *
 * A token is `clb_<id>.<sig>` where sig = base64url(HMAC-SHA256(AUTH_SECRET, "api-token:<id>")).
 * Knowing an id is not enough to build a token; rotating AUTH_SECRET invalidates all tokens.
 * Revocation, expiry and the user's status live in the database (see ./api-token.ts).
 */
export const API_TOKEN_PREFIX = 'clb_';

const encoder = new TextEncoder();

function secret(): string {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || '';
}

function base64url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signTokenId(id: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(`api-token:${id}`)));
}

/** Split `clb_<id>.<sig>`; null when the shape is wrong. */
export function parseApiToken(raw: string | null | undefined): { id: string; sig: string } | null {
  if (!raw || !raw.startsWith(API_TOKEN_PREFIX)) return null;
  const body = raw.slice(API_TOKEN_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0) return null;
  const id = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  return { id, sig };
}

/** Bearer token from an Authorization header value, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1] : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the token is well-formed and carries a valid signature (says nothing about revocation). */
export async function hasValidSignature(raw: string | null | undefined): Promise<boolean> {
  const parsed = parseApiToken(raw);
  if (!parsed || !secret()) return false;
  return constantTimeEqual(parsed.sig, await signTokenId(parsed.id));
}
