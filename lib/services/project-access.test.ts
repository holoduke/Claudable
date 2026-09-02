import { beforeEach, describe, expect, it, vi } from 'vitest';

// Cross-tenant isolation tests for the project access rules. Prisma is mocked
// so the pure decision logic can be exercised with users from different orgs.
// Access derives from ORG MEMBERSHIP (org_members), not from the legacy home
// org field — the fixtures below model both to prove which one counts.
const projectMembers: { projectId: string; userId: string; role: string }[] = [];
const orgMembers: { orgId: string; userId: string; role: string }[] = [];

vi.mock('@/lib/db/client', () => ({
  prisma: {
    projectMember: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { projectId, userId } = where.projectId_userId;
        return projectMembers.find((m) => m.projectId === projectId && m.userId === userId) ?? null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        projectMembers
          .filter((m) => m.userId === where.userId && where.projectId.in.includes(m.projectId))
          .map((m) => ({ projectId: m.projectId })),
      ),
    },
    orgMember: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { orgId, userId } = where.orgId_userId;
        const row = orgMembers.find((m) => m.orgId === orgId && m.userId === userId);
        return row ? { id: `${orgId}:${userId}`, ...row } : null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        orgMembers.filter((m) => m.userId === where.userId).map((m) => ({ orgId: m.orgId, role: m.role })),
      ),
    },
  },
}));
vi.mock('@/lib/auth/session', () => ({ getSessionUser: vi.fn() }));

import { accessibleProjectIds, canAccessProject, canWriteProject } from './project-access';

const ORG_A = 'org-newstory';
const ORG_B = 'org-customer';

function user(id: string, homeOrgId: string, role: 'admin' | 'user' = 'user') {
  return { id, orgId: homeOrgId, role } as any;
}
function project(id: string, orgId: string | null, opts: { ownerId?: string | null; visibility?: string } = {}) {
  return { id, orgId, ownerId: opts.ownerId ?? null, visibility: opts.visibility ?? 'org' };
}
function member(orgId: string, userId: string, role = 'lid') {
  orgMembers.push({ orgId, userId, role });
}

const alice = user('alice', ORG_A); // New Story member
const bob = user('bob', ORG_B); // customer member
const superadmin = user('root', ORG_A, 'admin');
const dave = user('dave', ORG_A); // staff who also supports the customer org

const projA = project('p-a', ORG_A);
const projB = project('p-b', ORG_B);

beforeEach(() => {
  projectMembers.length = 0;
  orgMembers.length = 0;
  member(ORG_A, 'alice');
  member(ORG_B, 'bob');
  member(ORG_A, 'root', 'beheerder');
  member(ORG_A, 'dave');
  member(ORG_B, 'dave', 'beheerder');
});

describe('tenant isolation: org-visible projects', () => {
  it('a member sees and may write projects of their own org only', async () => {
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

  it('listing filters to the caller memberships', async () => {
    const all = [projA, projB];
    expect([...(await accessibleProjectIds(alice, all))]).toEqual(['p-a']);
    expect([...(await accessibleProjectIds(bob, all))]).toEqual(['p-b']);
    expect((await accessibleProjectIds(superadmin, all)).size).toBe(2);
  });
});

describe('tenant isolation: membership, not the home-org field, decides', () => {
  it('a multi-org member reaches both orgs', async () => {
    expect(await canAccessProject(dave, projA)).toBe(true);
    expect(await canAccessProject(dave, projB)).toBe(true);
    expect([...(await accessibleProjectIds(dave, [projA, projB]))]).toEqual(['p-a', 'p-b']);
  });

  it('a user whose home org matches but who holds no membership is denied', async () => {
    const ghost = user('ghost', ORG_A); // home org A, but removed from org_members
    expect(await canAccessProject(ghost, projA)).toBe(false);
    expect(await canWriteProject(ghost, projA)).toBe(false);
    expect([...(await accessibleProjectIds(ghost, [projA]))]).toEqual([]);
  });

  it('an org admin role grants no extra project access', async () => {
    // dave is beheerder of ORG_B, but a restricted project there is still closed to him.
    const restrictedB = project('p-rb', ORG_B, { ownerId: 'bob', visibility: 'restricted' });
    expect(await canAccessProject(dave, restrictedB)).toBe(false);
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
    member(ORG_A, 'carol');
    expect(await canAccessProject(carol, orphan)).toBe(false);
  });
});

describe('tenant isolation: restricted projects', () => {
  const restricted = project('p-r', ORG_A, { ownerId: 'alice', visibility: 'restricted' });

  it('assignment grants read; editor role grants write; other orgs never', async () => {
    const carol = user('carol', ORG_A);
    member(ORG_A, 'carol');
    expect(await canAccessProject(carol, restricted)).toBe(false);

    projectMembers.push({ projectId: 'p-r', userId: 'carol', role: 'viewer' });
    expect(await canAccessProject(carol, restricted)).toBe(true);
    expect(await canWriteProject(carol, restricted)).toBe(false);

    projectMembers[0].role = 'editor';
    expect(await canWriteProject(carol, restricted)).toBe(true);

    expect(await canAccessProject(bob, restricted)).toBe(false);
  });
});
