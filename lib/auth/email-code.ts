/**
 * Sign-in with a one-time code sent by e-mail — for people who have no Google
 * account for their address (e.g. a customer on Microsoft 365).
 *
 * Security properties:
 *  - a code is only SENT to an address that may sign in (isSignInAllowed: an
 *    invitation, an existing member, an allowed domain); the request endpoint
 *    answers identically either way, so it reveals nothing about who exists;
 *  - only a keyed hash of the code is stored; codes are single-use, expire after
 *    10 minutes, allow 5 attempts, and a new code invalidates the previous ones;
 *  - requests are rate-limited per address and per client IP.
 * Possession of the code proves control of the mailbox, which is what Google's
 * email_verified proves for the Google provider.
 */
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { prisma } from '@/lib/db/client';
import { isSignInAllowed } from '@/lib/auth/provision';
import { loginCodeEmail, sendMail } from '@/lib/services/mail';

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_EMAIL_PER_HOUR = 5;
const MAX_REQUESTS_PER_IP_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ipRequests = new Map<string, number[]>();

function secret(): string {
  const s = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || '';
  if (!s) throw new Error('AUTH_SECRET is required for e-mail sign-in codes');
  return s;
}

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const lower = email.trim().toLowerCase();
  return lower.length <= 254 && EMAIL_RE.test(lower) ? lower : null;
}

function hashCode(email: string, code: string): string {
  return createHmac('sha256', secret()).update(`login-code:${email}:${code}`).digest('hex');
}

function ipAllowed(ip: string): boolean {
  const now = Date.now();
  const recent = (ipRequests.get(ip) ?? []).filter((t) => now - t < HOUR_MS);
  if (recent.length >= MAX_REQUESTS_PER_IP_PER_HOUR) {
    ipRequests.set(ip, recent);
    return false;
  }
  ipRequests.set(ip, [...recent, now]);
  return true;
}

/**
 * Request a code. Always resolves without revealing whether a code was sent.
 * Returns whether one was actually sent (for logging/tests only — never expose).
 */
export async function requestLoginCode(rawEmail: unknown, ip: string): Promise<boolean> {
  const email = normalizeEmail(rawEmail);
  if (!email || !ipAllowed(ip)) return false;
  if (!(await isSignInAllowed(email))) return false;

  const recent = await prisma.loginCode.count({ where: { email, createdAt: { gte: new Date(Date.now() - HOUR_MS) } } });
  if (recent >= MAX_CODES_PER_EMAIL_PER_HOUR) return false;

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await prisma.$transaction([
    // A new code replaces any outstanding one.
    prisma.loginCode.updateMany({ where: { email, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.loginCode.create({ data: { email, codeHash: hashCode(email, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) } }),
  ]);
  const mail = await sendMail(loginCodeEmail({ to: email, code, validMinutes: CODE_TTL_MS / 60_000 }));
  if (!mail.sent) console.error('[email-code] could not send sign-in code:', mail.reason);
  return mail.sent;
}

/** Verify a code; on success it is consumed and the (normalized) e-mail is returned. */
export async function verifyLoginCode(rawEmail: unknown, rawCode: unknown): Promise<string | null> {
  const email = normalizeEmail(rawEmail);
  const code = typeof rawCode === 'string' ? rawCode.replace(/\s+/g, '') : '';
  if (!email || !/^\d{6}$/.test(code)) return null;

  const entry = await prisma.loginCode.findFirst({
    where: { email, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!entry || entry.attempts >= MAX_ATTEMPTS) return null;

  const expected = Buffer.from(entry.codeHash, 'hex');
  const given = Buffer.from(hashCode(email, code), 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    await prisma.loginCode.update({ where: { id: entry.id }, data: { attempts: { increment: 1 } } });
    return null;
  }
  // Consume atomically: only the first concurrent verifier wins.
  const consumed = await prisma.loginCode.updateMany({ where: { id: entry.id, usedAt: null }, data: { usedAt: new Date() } });
  return consumed.count === 1 ? email : null;
}
