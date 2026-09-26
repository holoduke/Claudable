import { beforeEach, describe, expect, it, vi } from 'vitest';

// Personal API tokens: format, signature, revocation, expiry, and the rule that a token only ever
// acts with project rights (an admin's token is a normal user). Prisma is mocked.
type Row = { id: string; userId: string; name: string; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null };
type UserRow = { id: string; email: string; role: string; isActive: boolean; orgId: string; orgs: number };
const tokens: Row[] = [];
const users: UserRow[] = [];

vi.mock('@/lib/db/client', () => ({
  prisma: {
    apiToken: {
      count: vi.fn(async ({ where }: any) => tokens.filter((t) => t.userId === where.userId && !t.revokedAt).length),
      create: vi.fn(async ({ data }: any) => {
        const row: Row = { createdAt: new Date(), lastUsedAt: null, revokedAt: null, ...data };
        tokens.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: any) => tokens.filter((t) => t.userId === where.userId && !t.revokedAt)),
      findUnique: vi.fn(async ({ where }: any) => {
        const t = tokens.find((x) => x.id === where.id);
        if (!t) return null;
        const u = users.find((x) => x.id === t.userId)!;
        const { orgs, ...user } = u;
        return { ...t, user: { ...user, _count: { orgMemberships: orgs } } };
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(tokens.find((t) => t.id === where.id)!, data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = tokens.filter((t) => t.id === where.id && t.userId === where.userId && !t.revokedAt);
        hit.forEach((t) => Object.assign(t, data));
        return { count: hit.length };
      }),
    },
  },
}));

import { createApiToken, listApiTokens, resolveApiTokenUser, revokeApiToken, ApiTokenError } from './api-token';
import { bearerToken, hasValidSignature, parseApiToken } from './api-token-signature';

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-secret';
  tokens.length = 0;
  users.length = 0;
  users.push({ id: 'u1', email: 'hub@example.com', role: 'user', isActive: true, orgId: 'o1', orgs: 1 });
  users.push({ id: 'admin', email: 'boss@example.com', role: 'admin', isActive: true, orgId: 'o1', orgs: 1 });
});

describe('personal API tokens', () => {
  it('creates a clb_ token that resolves to its user', async () => {
    const { token, record } = await createApiToken('u1', 'Slack Hub');
    expect(token).toMatch(/^clb_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/);
    expect(record.name).toBe('Slack Hub');
    expect(record.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 364 * 86400_000);
    expect((await resolveApiTokenUser(token))?.id).toBe('u1');
    expect(await listApiTokens('u1')).toHaveLength(1);
  });

  it('rejects a forged or tampered token, also at the proxy', async () => {
    const { token } = await createApiToken('u1', 'x');
    const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect(await hasValidSignature(tampered)).toBe(false);
    expect(await resolveApiTokenUser(tampered)).toBeNull();
    const otherId = token.replace(/^clb_[^.]+/, 'clb_' + 'A'.repeat(24));
    expect(await resolveApiTokenUser(otherId)).toBeNull();
    process.env.AUTH_SECRET = 'rotated';
    expect(await hasValidSignature(token)).toBe(false);
  });

  it('stops working once revoked or expired', async () => {
    const a = await createApiToken('u1', 'a');
    expect(await revokeApiToken('u1', a.record.id)).toBe(true);
    expect(await resolveApiTokenUser(a.token)).toBeNull();
    expect(await revokeApiToken('u1', a.record.id)).toBe(false);

    const b = await createApiToken('u1', 'b', 1);
    tokens.find((t) => t.id === b.record.id)!.expiresAt = new Date(Date.now() - 1000);
    expect(await resolveApiTokenUser(b.token)).toBeNull();
  });

  it('cannot revoke someone else\'s token', async () => {
    const a = await createApiToken('u1', 'a');
    expect(await revokeApiToken('admin', a.record.id)).toBe(false);
    expect((await resolveApiTokenUser(a.token))?.id).toBe('u1');
  });

  it('follows the login rules: inactive users and users without an organisation are refused', async () => {
    const { token } = await createApiToken('u1', 'a');
    users[0].isActive = false;
    expect(await resolveApiTokenUser(token)).toBeNull();
    users[0].isActive = true;
    users[0].orgs = 0;
    expect(await resolveApiTokenUser(token)).toBeNull();
  });

  it('never grants admin rights: an admin token acts as a normal user', async () => {
    const { token } = await createApiToken('admin', 'script');
    const user = await resolveApiTokenUser(token);
    expect(user?.id).toBe('admin');
    expect(user?.role).toBe('user');
  });

  it('validates name, lifetime and the per-user limit', async () => {
    await expect(createApiToken('u1', '  ')).rejects.toBeInstanceOf(ApiTokenError);
    await expect(createApiToken('u1', 'x', 0)).rejects.toBeInstanceOf(ApiTokenError);
    await expect(createApiToken('u1', 'x', 366)).rejects.toBeInstanceOf(ApiTokenError);
    for (let i = 0; i < 20; i++) await createApiToken('u1', `t${i}`);
    await expect(createApiToken('u1', 'one too many')).rejects.toBeInstanceOf(ApiTokenError);
  });

  it('records last use at most every few minutes', async () => {
    const { token, record } = await createApiToken('u1', 'a');
    await resolveApiTokenUser(token);
    const first = tokens.find((t) => t.id === record.id)!.lastUsedAt;
    expect(first).toBeInstanceOf(Date);
    await resolveApiTokenUser(token);
    expect(tokens.find((t) => t.id === record.id)!.lastUsedAt).toBe(first);
  });

  it('parses only well-formed bearer tokens', () => {
    expect(bearerToken('Bearer clb_abc.def')).toBe('clb_abc.def');
    expect(bearerToken('Basic xyz')).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(parseApiToken('clb_short.sig')).toBeNull();
    expect(parseApiToken('ghp_' + 'a'.repeat(30))).toBeNull();
  });
});
