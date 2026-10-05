import { beforeEach, describe, expect, it, vi } from 'vitest';

// Deactivating a user must not leave an org without an owner who can sign in.
const members: { orgId: string; userId: string; role: string }[] = [];
const active = new Map<string, boolean>();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    orgMember: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; role: string } }) =>
        members.filter((m) => m.userId === where.userId && m.role === where.role).map((m) => ({ orgId: m.orgId }))),
      count: vi.fn(async ({ where }: { where: { orgId: string; role: string; userId: { not: string } } }) =>
        members.filter((m) => m.orgId === where.orgId && m.role === where.role && m.userId !== where.userId.not && active.get(m.userId)).length),
    },
  },
}));
vi.mock('@/lib/services/org-access', () => ({ canActorSetRole: () => true }));
vi.mock('@/lib/services/audit', () => ({ recordAudit: vi.fn() }));
vi.mock('@/lib/services/mail', () => ({ sendMail: vi.fn(), inviteEmail: vi.fn(), addedToOrgEmail: vi.fn() }));

import { assertNotLastActiveOwnerOfAnyOrg, isOrgError } from './orgs';

beforeEach(() => {
  members.length = 0;
  active.clear();
});

describe('assertNotLastActiveOwnerOfAnyOrg', () => {
  it('refuses when no other ACTIVE owner remains (an inactive co-owner does not count)', async () => {
    members.push({ orgId: 'o1', userId: 'a', role: 'eigenaar' }, { orgId: 'o1', userId: 'b', role: 'eigenaar' });
    active.set('a', true).set('b', false);
    const err = await assertNotLastActiveOwnerOfAnyOrg('a').catch((e) => e);
    expect(isOrgError(err) && err.code).toBe('last_owner');
  });
  it('allows when another active owner exists, or the user owns nothing', async () => {
    members.push({ orgId: 'o1', userId: 'a', role: 'eigenaar' }, { orgId: 'o1', userId: 'b', role: 'eigenaar' }, { orgId: 'o2', userId: 'c', role: 'lid' });
    active.set('a', true).set('b', true).set('c', true);
    await expect(assertNotLastActiveOwnerOfAnyOrg('a')).resolves.toBeUndefined();
    await expect(assertNotLastActiveOwnerOfAnyOrg('c')).resolves.toBeUndefined();
  });
});
