import { beforeEach, describe, expect, it, vi } from 'vitest';

// The permissions contract returned by GET /api/projects/[id] must mirror the
// API gates exactly: manage = owner/admin, configure = writer, both staff-only
// in a customer project, fullEdit = not restricted by an edit profile.
const state = {
  canWrite: true,
  customer: false,
  internal: true,
  restricted: false,
};

vi.mock('@/lib/services/project-access', () => ({
  canWriteProject: vi.fn(async () => state.canWrite),
  canManageProject: (user: { id: string; role: string }, project: { ownerId: string | null }) =>
    user.role === 'admin' || project.ownerId === user.id,
}));
vi.mock('@/lib/services/tenant-policy', () => ({
  isCustomerProject: vi.fn(async () => state.customer),
  isInternalUser: vi.fn(async () => state.internal),
}));
vi.mock('@/lib/services/edit-profiles', () => ({
  resolveEditProfile: vi.fn(async () => ({ profile: { id: state.restricted ? 'content' : 'full' }, source: 'member' })),
  isRestricted: (profile: { id: string }) => profile.id !== 'full',
}));

import { ALL_PERMISSIONS, computeProjectPermissions } from './settings-permissions';

const owner = { id: 'u-owner', role: 'user' } as never;
const editor = { id: 'u-editor', role: 'user' } as never;
const admin = { id: 'u-admin', role: 'admin' } as never;
const project = { id: 'p1', ownerId: 'u-owner', orgId: 'o1', visibility: 'org' };

beforeEach(() => {
  Object.assign(state, { canWrite: true, customer: false, internal: true, restricted: false });
});

describe('computeProjectPermissions', () => {
  it('gives the owner of an internal project everything', async () => {
    expect(await computeProjectPermissions(owner, project)).toEqual(ALL_PERMISSIONS);
  });

  it('lets an editor write and configure but not manage', async () => {
    expect(await computeProjectPermissions(editor, project)).toEqual({
      canWrite: true, canManage: false, canConfigure: true, fullEdit: true,
    });
  });

  it('a viewer can neither write nor configure', async () => {
    state.canWrite = false;
    const p = await computeProjectPermissions(editor, project);
    expect(p.canWrite).toBe(false);
    expect(p.canConfigure).toBe(false);
  });

  it('a customer in a customer project cannot manage or configure, even as owner', async () => {
    state.customer = true;
    state.internal = false;
    expect(await computeProjectPermissions(owner, project)).toEqual({
      canWrite: true, canManage: false, canConfigure: false, fullEdit: true,
    });
  });

  it('staff keep manage/configure in a customer project', async () => {
    state.customer = true;
    const p = await computeProjectPermissions(admin, project);
    expect(p.canManage).toBe(true);
    expect(p.canConfigure).toBe(true);
  });

  it('a restricted edit profile clears fullEdit', async () => {
    state.restricted = true;
    expect((await computeProjectPermissions(editor, project)).fullEdit).toBe(false);
  });

  it('ALL_PERMISSIONS (auth off) is all true', () => {
    expect(Object.values(ALL_PERMISSIONS).every(Boolean)).toBe(true);
  });
});
