import { beforeEach, describe, expect, it, vi } from 'vitest';

// Cross-tenant isolation tests for the project access rules. Prisma is mocked
// so the pure decision logic can be exercised with users from different orgs.
const memberships: { projectId: string; userId: string; role: string }[] = [];

vi.mock('@/lib/db/client', () => ({
  prisma: {
    projectMember: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { projectId, userId } = where.projectId_userId;
        return memberships.find((m) => m.projectId === projectId && m.userId === userId) ?? null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        memberships
          .filter((m) => m.userId === where.userId && where.projectId.in.includes(m.projectId))
          .map((m) => ({ projectId: m.projectId })),
      ),
    },
  },
}));
vi.mock('@/lib/auth/session', () => ({ getSessionUser: vi.fn() }));

import { accessibleProjectIds, canAccessProject, canWriteProject } from './project-access';

const ORG_A = 'org-newstory';
const ORG_B = 'org-customer';

function user(id: string, orgId: string, role: 'admin' | 'user' = 'user') {
  return { id, orgId, role } as any;
}
function project(id: string, orgId: string | null, opts: { ownerId?: string | null; visibility?: string } = {}) {
  return { id, orgId, ownerId: opts.ownerId ?? null, visibility: opts.visibility ?? 'org' };
}

const alice = user('alice', ORG_A);
const bob = user('bob', ORG_B);
const superadmin = user('root', ORG_A, 'admin');

beforeEach(() => {
  memberships.length = 0;
});

describe('tenant isolation: org-visible projects', () => {
  const projA = project('p-a', ORG_A);
  const projB = project('p-b', ORG_B);

  it('a user sees and may write projects of their own org only', async () => {
    expect(await canAccessProject(alice, projA)).toBe(true);
    expect(await canWriteProject(alice, projA)).toBe(true);
    expect(await canAccessProject(alice, projB)).toBe(false);
    expect(await canWriteProject(alice, projB)).toBe(false);
    expect(await canAccessProject(bob, projA)).toBe(false);
  });

  it('a global admin sees everything', async () => {
    expect(await canAccessProject(superadmin, projB)).toBe(true);
    expect(await canWriteProject(superadmin, projB)).toBe(true);
  });

  it('listing filters to the caller org', async () => {
    const all = [projA, projB];
    expect([...(await accessibleProjectIds(alice, all))]).toEqual(['p-a']);
    expect([...(await accessibleProjectIds(bob, all))]).toEqual(['p-b']);
    expect((await accessibleProjectIds(superadmin, all)).size).toBe(2);
  });
});

describe('tenant isolation: project without an org (data error) is closed', () => {
  const orphan = project('p-none', null, { ownerId: 'alice' });

  it('is NOT visible across orgs (no legacy allow-all fallback)', async () => {
    expect(await canAccessProject(bob, orphan)).toBe(false);
    expect(await canWriteProject(bob, orphan)).toBe(false);
    expect([...(await accessibleProjectIds(bob, [orphan]))]).toEqual([]);
  });

  it('stays reachable for its owner and for global admins', async () => {
    expect(await canAccessProject(alice, orphan)).toBe(true); // owner
    expect(await canAccessProject(superadmin, orphan)).toBe(true);
  });

  it('is closed even to same-org users who are not the owner', async () => {
    const carol = user('carol', ORG_A);
    expect(await canAccessProject(carol, orphan)).toBe(false);
  });
});

describe('tenant isolation: restricted projects', () => {
  const restricted = project('p-r', ORG_A, { ownerId: 'alice', visibility: 'restricted' });

  it('membership grants read; editor role grants write; other orgs never', async () => {
    const carol = user('carol', ORG_A);
    expect(await canAccessProject(carol, restricted)).toBe(false);

    memberships.push({ projectId: 'p-r', userId: 'carol', role: 'viewer' });
    expect(await canAccessProject(carol, restricted)).toBe(true);
    expect(await canWriteProject(carol, restricted)).toBe(false);

    memberships[0].role = 'editor';
    expect(await canWriteProject(carol, restricted)).toBe(true);

    expect(await canAccessProject(bob, restricted)).toBe(false);
  });
});
