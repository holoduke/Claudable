/**
 * Personal API tokens: a script or bot acts as one user, with exactly that user's project access.
 *
 * - Created by the user in Settings → Account (or, for a service account such as the Slack "Hub" bot,
 *   by an admin with scripts/create-api-token.mjs). The full token is shown once and never stored.
 * - Checked on every request: signature (also at the proxy), not revoked, not expired, user active and,
 *   like a login, a non-admin must still belong to an organisation.
 * - Deliberately limited: a token never grants admin rights (an admin's token acts as a normal user)
 *   and cannot create or list tokens itself (the token routes require a real session).
 */
import { randomBytes } from 'crypto';
import type { ApiToken, User } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { API_TOKEN_PREFIX, hasValidSignature, parseApiToken, signTokenId } from './api-token-signature';

const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000; // write lastUsedAt at most every 5 minutes per token
const MAX_TOKENS_PER_USER = 20;
const MAX_LIFETIME_DAYS = 365;

export type PublicApiToken = Pick<ApiToken, 'id' | 'name' | 'createdAt' | 'lastUsedAt' | 'expiresAt'>;

function toPublic(t: ApiToken): PublicApiToken {
  return { id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt };
}

export class ApiTokenError extends Error {}

/** Create a token for userId. Returns the full token (show once) and its public record. */
export async function createApiToken(userId: string, name: string, expiresInDays?: number | null): Promise<{ token: string; record: PublicApiToken }> {
  const label = (name ?? '').trim().slice(0, 80);
  if (!label) throw new ApiTokenError('A name is required');
  const days = expiresInDays == null ? MAX_LIFETIME_DAYS : Math.floor(expiresInDays);
  if (!(days >= 1 && days <= MAX_LIFETIME_DAYS)) throw new ApiTokenError(`Lifetime must be 1-${MAX_LIFETIME_DAYS} days`);
  const active = await prisma.apiToken.count({ where: { userId, revokedAt: null } });
  if (active >= MAX_TOKENS_PER_USER) throw new ApiTokenError(`At most ${MAX_TOKENS_PER_USER} active tokens`);
  const id = randomBytes(18).toString('base64url');
  const record = await prisma.apiToken.create({
    data: { id, userId, name: label, expiresAt: new Date(Date.now() + days * 86400_000) },
  });
  return { token: `${API_TOKEN_PREFIX}${id}.${await signTokenId(id)}`, record: toPublic(record) };
}

export async function listApiTokens(userId: string): Promise<PublicApiToken[]> {
  const rows = await prisma.apiToken.findMany({ where: { userId, revokedAt: null }, orderBy: { createdAt: 'desc' } });
  return rows.map(toPublic);
}

/** Revoke one of userId's tokens. False when it does not exist or belongs to someone else. */
export async function revokeApiToken(userId: string, id: string): Promise<boolean> {
  const res = await prisma.apiToken.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return res.count > 0;
}

/** The user a raw token acts for, or null when it is forged, revoked, expired or the user may not sign in. */
export async function resolveApiTokenUser(raw: string | null | undefined): Promise<User | null> {
  const parsed = parseApiToken(raw);
  if (!parsed || !(await hasValidSignature(raw))) return null;
  const row = await prisma.apiToken.findUnique({
    where: { id: parsed.id },
    include: { user: { include: { _count: { select: { orgMemberships: true } } } } },
  });
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  const { _count, ...user } = row.user as User & { _count: { orgMemberships: number } };
  if (!user.isActive) return null;
  // A token acts with project rights only: an admin account is treated as a normal user, so every
  // `role === 'admin'` check in the app stays closed. It then needs an organisation like any
  // non-admin (stricter than the session JWT callback, which lets an org-less admin in).
  if (_count.orgMemberships === 0) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  return user.role === 'admin' ? { ...user, role: 'user' } : user;
}
