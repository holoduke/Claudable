import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sign-in routing rules: invites first, then domain auto-join into the org that
// owns the domain, and existing users need a live membership. Prisma is mocked.
type UserRow = { id: string; email: string; role: string; isActive: boolean; orgId: string };
const users: UserRow[] = [];
const orgs: { id: string; name: string; domain: string | null }[] = [];
const memberships: { orgId: string; userId: string; role: string }[] = [];
const invites: { id: string; orgId: string; email: string; role: string; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null }[] = [];
const audit: string[] = [];
const removals: { userId: string; orgId: string }[] = [];
let seq = 0;

vi.mock('@/lib/db/client', () => ({
  prisma: {
    organization: {
      upsert: vi.fn(async ({ where, create }: any) => {
        let o = orgs.find((x) => x.domain === where.domain);
        if (!o) { o = { id: `org-${++seq}`, name: create.name, domain: create.domain }; orgs.push(o); }
        return o;
      }),
      findUnique: vi.fn(async ({ where }: any) =>
        orgs.find((o) => (where.id ? o.id === where.id : o.domain === where.domain)) ?? null),
    },
    user: {
      findUnique: vi.fn(async ({ where, include }: any) => {
        const u = users.find((x) => x.email === where.email) ?? null;
        if (!u) return null;
        return include ? { ...u, _count: { orgMemberships: memberships.filter((m) => m.userId === u.id).length } } : u;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const u = users.find((x) => x.id === where.id)!;
        Object.assign(u, Object.fromEntries(Object.entries(data).filter(([k]) => ['role', 'isActive'].includes(k))));
        return u;
      }),
      create: vi.fn(async ({ data }: any) => {
        const u = { id: `u-${++seq}`, email: data.email, role: data.role, isActive: true, orgId: data.orgId };
        users.push(u);
        if (data.orgMemberships?.create) memberships.push({ orgId: data.orgMemberships.create.orgId, userId: u.id, role: data.orgMemberships.create.role });
        return u;
      }),
    },
    orgMember: {
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const { orgId, userId } = where.orgId_userId;
        const m = memberships.find((x) => x.orgId === orgId && x.userId === userId);
        if (m) { if (update.role) m.role = update.role; return m; }
        memberships.push({ ...create }); return create;
      }),
    },
    orgInvite: {
      findMany: vi.fn(async ({ where }: any) => {
        const now = Date.now();
        return invites.filter((i) => i.email === where.email && !i.acceptedAt && !i.revokedAt && i.expiresAt.getTime() > now);
      }),
      update: vi.fn(async ({ where, data }: any) => { Object.assign(invites.find((i) => i.id === where.id)!, data); }),
    },
    auditEvent: {
      create: vi.fn(async ({ data }: any) => { audit.push(data.action); }),
      findFirst: vi.fn(async ({ where }: any) =>
        removals.some((r) => r.userId === where.targetId && r.orgId === where.orgId) ? { id: 'rm' } : null),
    },
  },
}));

import { isSignInAllowed, provisionUser } from './provision';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  users.length = 0; orgs.length = 0; memberships.length = 0; invites.length = 0; audit.length = 0; removals.length = 0; seq = 0;
  process.env.ALLOWED_EMAIL_DOMAINS = 'newstory.nl';
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'boot@newstory.nl';
  orgs.push({ id: 'org-ns', name: 'New Story', domain: 'newstory.nl' });
  orgs.push({ id: 'org-micros', name: 'Micros.nl', domain: 'micros.nl' });
});

describe('who may sign in', () => {
  it('allowed domain with a matching org: yes; unknown domain: no', async () => {
    expect(await isSignInAllowed('new@newstory.nl')).toBe(true);
    expect(await isSignInAllowed('someone@gmail.com')).toBe(false);
  });

  it('an org domain that is NOT in ALLOWED_EMAIL_DOMAINS does not auto-join (invite-only)', async () => {
    expect(await isSignInAllowed('klant@micros.nl')).toBe(false);
  });

  it('an allowed domain without an owning org is refused, never filed under the primary org', async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'newstory.nl,orphan.nl';
    expect(await isSignInAllowed('x@orphan.nl')).toBe(false);
  });

  it('a pending invite admits any domain; expired or revoked ones do not', async () => {
    invites.push({ id: 'i1', orgId: 'org-micros', email: 'a@gmail.com', role: 'lid', expiresAt: new Date(Date.now() + DAY), acceptedAt: null, revokedAt: null });
    invites.push({ id: 'i2', orgId: 'org-micros', email: 'b@gmail.com', role: 'lid', expiresAt: new Date(Date.now() - DAY), acceptedAt: null, revokedAt: null });
    invites.push({ id: 'i3', orgId: 'org-micros', email: 'c@gmail.com', role: 'lid', expiresAt: new Date(Date.now() + DAY), acceptedAt: null, revokedAt: new Date() });
    expect(await isSignInAllowed('a@gmail.com')).toBe(true);
    expect(await isSignInAllowed('b@gmail.com')).toBe(false);
    expect(await isSignInAllowed('c@gmail.com')).toBe(false);
  });

  it('a user REMOVED from their last org (audited) is refused until re-invited', async () => {
    users.push({ id: 'u1', email: 'old@example.com', role: 'user', isActive: true, orgId: 'org-micros' });
    removals.push({ userId: 'u1', orgId: 'org-micros' });
    expect(await isSignInAllowed('old@example.com')).toBe(false);
    expect(memberships).toEqual([]); // no resurrection
    memberships.push({ orgId: 'org-micros', userId: 'u1', role: 'lid' });
    expect(await isSignInAllowed('old@example.com')).toBe(true);
    users[0].isActive = false;
    expect(await isSignInAllowed('old@example.com')).toBe(false);
  });

  it('a LEGACY account (home org set, never had a membership, never removed) is healed once', async () => {
    users.push({ id: 'u2', email: 'legacy@newstory.nl', role: 'user', isActive: true, orgId: 'org-ns' });
    expect(await isSignInAllowed('legacy@newstory.nl')).toBe(true);
    expect(memberships).toEqual([{ orgId: 'org-ns', userId: 'u2', role: 'lid' }]);
  });
});

describe('where a new user lands', () => {
  it('auto-join provisions into the org that owns the domain, as lid', async () => {
    const u = await provisionUser('new@newstory.nl', 'New', null);
    expect(u.orgId).toBe('org-ns');
    expect(memberships).toEqual([{ orgId: 'org-ns', userId: u.id, role: 'lid' }]);
  });

  it('an invite provisions into the inviting org with the invited role and is marked accepted', async () => {
    invites.push({ id: 'i1', orgId: 'org-micros', email: 'klant@gmail.com', role: 'beheerder', expiresAt: new Date(Date.now() + DAY), acceptedAt: null, revokedAt: null });
    const u = await provisionUser('klant@gmail.com', 'Klant', null);
    expect(u.orgId).toBe('org-micros');
    expect(memberships).toEqual([{ orgId: 'org-micros', userId: u.id, role: 'beheerder' }]);
    expect(invites[0].acceptedAt).not.toBeNull();
    expect(audit).toContain('org.invite.accepted');
  });

  it('a routine sign-in does NOT recreate a membership that was removed', async () => {
    users.push({ id: 'u1', email: 'old@newstory.nl', role: 'user', isActive: true, orgId: 'org-ns' });
    memberships.push({ orgId: 'org-micros', userId: 'u1', role: 'lid' }); // still member elsewhere
    await provisionUser('old@newstory.nl', 'Old', null);
    expect(memberships.some((m) => m.orgId === 'org-ns')).toBe(false);
  });

  it('the bootstrap admin is always re-promoted and kept in the primary org', async () => {
    users.push({ id: 'u1', email: 'boot@newstory.nl', role: 'user', isActive: false, orgId: 'org-ns' });
    const u = await provisionUser('boot@newstory.nl', 'Boot', null);
    expect(u.role).toBe('admin');
    expect(u.isActive).toBe(true);
    expect(memberships).toEqual([{ orgId: 'org-ns', userId: 'u1', role: 'beheerder' }]);
  });
});
