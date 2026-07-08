import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let project: { claudeCredentialId: string | null } = { claudeCredentialId: null };
const creds: Record<string, { ownerId: string; shareable: boolean }> = {};
const ownCredByUser: Record<string, boolean> = {};
const users: Record<string, { email: string }> = {};

vi.mock('@/lib/db/client', () => ({
  prisma: {
    project: { findUnique: vi.fn(async () => project) },
    claudeCredential: {
      findUnique: vi.fn(async ({ where }: any) => creds[where.id] ?? null),
      findFirst: vi.fn(async ({ where }: any) => (ownCredByUser[where.ownerId] ? { id: 'own' } : null)),
    },
    user: { findUnique: vi.fn(async ({ where }: any) => users[where.id] ?? null) },
  },
}));

import { runUsesRequestersOwnAccount } from './claude-credentials';

describe('runUsesRequestersOwnAccount (connector eligibility)', () => {
  beforeEach(() => {
    project = { claudeCredentialId: null };
    for (const k of Object.keys(creds)) delete creds[k];
    for (const k of Object.keys(ownCredByUser)) delete ownCredByUser[k];
    for (const k of Object.keys(users)) delete users[k];
    delete process.env.CLAUDE_GLOBAL_TOKEN_OWNER;
  });
  afterEach(() => vi.clearAllMocks());

  it('auth off (no requester) → own account', async () => {
    expect(await runUsesRequestersOwnAccount('p1', undefined)).toBe(true);
  });

  it('shared credential owned by someone else → NOT own (teammate must not inherit)', async () => {
    project.claudeCredentialId = 'c1';
    creds.c1 = { ownerId: 'alice', shareable: true };
    expect(await runUsesRequestersOwnAccount('p1', 'bob')).toBe(false);
  });

  it('assigned credential owned by the requester → own', async () => {
    project.claudeCredentialId = 'c1';
    creds.c1 = { ownerId: 'bob', shareable: true };
    expect(await runUsesRequestersOwnAccount('p1', 'bob')).toBe(true);
  });

  it('requester has their own credential (no assigned) → own', async () => {
    ownCredByUser.bob = true;
    expect(await runUsesRequestersOwnAccount('p1', 'bob')).toBe(true);
  });

  it('global env token, requester not declared owner → NOT own', async () => {
    expect(await runUsesRequestersOwnAccount('p1', 'bob')).toBe(false);
  });

  it('global env token, requester IS the declared owner (by email) → own', async () => {
    process.env.CLAUDE_GLOBAL_TOKEN_OWNER = 'gillis@newstory.nl';
    users.bob = { email: 'gillis@newstory.nl' };
    expect(await runUsesRequestersOwnAccount('p1', 'bob')).toBe(true);
  });
});
