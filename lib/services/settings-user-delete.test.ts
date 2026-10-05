import { beforeEach, describe, expect, it, vi } from 'vitest';

// Deleting an account must never leave an organisation without an owner:
// deleteUser() refuses with OrgError 'last_owner' before touching anything.
const members: { orgId: string; userId: string; role: string }[] = [];
const deleted: string[] = [];

vi.mock('@/lib/db/client', () => {
  const tx = {
    claudeCredential: { updateMany: vi.fn(async () => ({ count: 0 })) },
    user: { delete: vi.fn(async ({ where }: { where: { id: string } }) => { deleted.push(where.id); return { id: where.id }; }) },
  };
  return {
    prisma: {
      orgMember: {
        findMany: vi.fn(async ({ where }: { where: { userId: string; role: string } }) =>
          members.filter((m) => m.userId === where.userId && m.role === where.role).map((m) => ({ orgId: m.orgId }))),
        findUnique: vi.fn(async ({ where }: { where: { orgId_userId: { orgId: string; userId: string } } }) => {
          const { orgId, userId } = where.orgId_userId;
          return members.find((m) => m.orgId === orgId && m.userId === userId) ?? null;
        }),
        count: vi.fn(async ({ where }: { where: { orgId: string; role: string } }) =>
          members.filter((m) => m.orgId === where.orgId && m.role === where.role).length),
      },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    },
  };
});
vi.mock('@/lib/services/org-access', () => ({ canActorSetRole: () => true }));
vi.mock('@/lib/services/audit', () => ({ recordAudit: vi.fn() }));
vi.mock('@/lib/services/mail', () => ({ sendMail: vi.fn(), inviteEmail: vi.fn(), addedToOrgEmail: vi.fn() }));

import { deleteUser } from './users';
import { isOrgError } from './orgs';
import { orgErrorResponse } from './settings-org-errors';

beforeEach(() => {
  members.length = 0;
  deleted.length = 0;
});

describe('deleteUser last-owner guard', () => {
  it('refuses to delete the only owner of an organisation', async () => {
    members.push({ orgId: 'o1', userId: 'alice', role: 'eigenaar' });
    const err = await deleteUser('alice', 'admin').catch((e) => e);
    expect(isOrgError(err)).toBe(true);
    expect(err.code).toBe('last_owner');
    expect(deleted).toEqual([]);
  });

  it('maps the refusal to a 409 with the stable code', async () => {
    members.push({ orgId: 'o1', userId: 'alice', role: 'eigenaar' });
    const err = await deleteUser('alice').catch((e) => e);
    const res = orgErrorResponse(err)!;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, error: 'last_owner' });
  });

  it('deletes an owner when another owner remains', async () => {
    members.push({ orgId: 'o1', userId: 'alice', role: 'eigenaar' }, { orgId: 'o1', userId: 'bob', role: 'eigenaar' });
    await deleteUser('alice');
    expect(deleted).toEqual(['alice']);
  });

  it('deletes a plain member', async () => {
    members.push({ orgId: 'o1', userId: 'carol', role: 'lid' });
    await deleteUser('carol');
    expect(deleted).toEqual(['carol']);
  });

  it('non-org errors fall through (null)', () => {
    expect(orgErrorResponse(new Error('boom'))).toBeNull();
  });
});
