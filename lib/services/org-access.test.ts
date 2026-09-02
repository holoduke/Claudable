import { beforeEach, describe, expect, it, vi } from 'vitest';

// Org role policy + the org gates, with Prisma and the session mocked.
const orgMembers: { orgId: string; userId: string; role: string }[] = [];
const orgs = new Set<string>(['org-a', 'org-b']);
let sessionUser: any = null;

vi.mock('@/lib/db/client', () => ({
  prisma: {
    organization: {
      findUnique: vi.fn(async ({ where }: any) => (orgs.has(where.id) ? { id: where.id } : null)),
    },
    orgMember: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { orgId, userId } = where.orgId_userId;
        const row = orgMembers.find((m) => m.orgId === orgId && m.userId === userId);
        return row ? { id: 'x', ...row } : null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        orgMembers.filter((m) => m.userId === where.userId).map((m) => ({ orgId: m.orgId, role: m.role })),
      ),
    },
  },
}));
vi.mock('@/lib/auth/session', () => ({ getSessionUser: vi.fn(async () => sessionUser) }));

import {
  canActorSetRole,
  isOrgMember,
  orgIdsFor,
  requireOrgManager,
  requireOrgMember,
} from './org-access';

beforeEach(() => {
  orgMembers.length = 0;
  sessionUser = null;
});

describe('role policy: who may set which role', () => {
  const superadmin = { superadmin: true, role: null };
  const owner = { superadmin: false, role: 'eigenaar' as const };
  const admin = { superadmin: false, role: 'beheerder' as const };
  const member = { superadmin: false, role: 'lid' as const };
  const outsider = { superadmin: false, role: null };

  it('superadmin and eigenaar may do anything', () => {
    for (const actor of [superadmin, owner]) {
      expect(canActorSetRole(actor, null, 'eigenaar')).toBe(true);
      expect(canActorSetRole(actor, 'eigenaar', 'lid')).toBe(true);
      expect(canActorSetRole(actor, 'eigenaar', null)).toBe(true);
    }
  });

  it('beheerder manages lid/beheerder but never touches or creates an eigenaar', () => {
    expect(canActorSetRole(admin, null, 'lid')).toBe(true);
    expect(canActorSetRole(admin, null, 'beheerder')).toBe(true);
    expect(canActorSetRole(admin, 'beheerder', 'lid')).toBe(true);
    expect(canActorSetRole(admin, 'lid', null)).toBe(true);
    expect(canActorSetRole(admin, null, 'eigenaar')).toBe(false);
    expect(canActorSetRole(admin, 'lid', 'eigenaar')).toBe(false);
    expect(canActorSetRole(admin, 'eigenaar', 'lid')).toBe(false);
    expect(canActorSetRole(admin, 'eigenaar', null)).toBe(false);
  });

  it('lid and non-members may change nothing', () => {
    expect(canActorSetRole(member, null, 'lid')).toBe(false);
    expect(canActorSetRole(outsider, null, 'lid')).toBe(false);
  });
});

describe('membership helpers', () => {
  it('report exactly the orgs a user belongs to', async () => {
    orgMembers.push({ orgId: 'org-a', userId: 'u1', role: 'lid' }, { orgId: 'org-b', userId: 'u1', role: 'beheerder' });
    expect([...(await orgIdsFor('u1'))].sort()).toEqual(['org-a', 'org-b']);
    expect(await isOrgMember('u1', 'org-a')).toBe(true);
    expect(await isOrgMember('u1', 'org-zzz')).toBe(false);
    expect(await isOrgMember('u1', null)).toBe(false);
    expect(await isOrgMember('u2', 'org-a')).toBe(false);
  });
});

describe('org gates', () => {
  it('reject anonymous callers and unknown orgs', async () => {
    expect(await requireOrgMember('org-a')).toMatchObject({ ok: false, status: 401 });
    sessionUser = { id: 'u1', role: 'user' };
    expect(await requireOrgMember('nope')).toMatchObject({ ok: false, status: 404 });
  });

  it('member gate: members and superadmins pass, outsiders do not', async () => {
    orgMembers.push({ orgId: 'org-a', userId: 'u1', role: 'lid' });
    sessionUser = { id: 'u1', role: 'user' };
    expect(await requireOrgMember('org-a')).toMatchObject({ ok: true, actor: { role: 'lid', superadmin: false } });
    expect(await requireOrgMember('org-b')).toMatchObject({ ok: false, status: 403 });
    sessionUser = { id: 'root', role: 'admin' };
    expect(await requireOrgMember('org-b')).toMatchObject({ ok: true, actor: { role: null, superadmin: true } });
  });

  it('manager gate: only eigenaar/beheerder of THAT org, or superadmin', async () => {
    orgMembers.push(
      { orgId: 'org-a', userId: 'u1', role: 'lid' },
      { orgId: 'org-b', userId: 'u1', role: 'beheerder' },
    );
    sessionUser = { id: 'u1', role: 'user' };
    expect(await requireOrgManager('org-a')).toMatchObject({ ok: false, status: 403 });
    expect(await requireOrgManager('org-b')).toMatchObject({ ok: true, actor: { role: 'beheerder' } });
    sessionUser = { id: 'root', role: 'admin' };
    expect(await requireOrgManager('org-a')).toMatchObject({ ok: true });
  });
});
