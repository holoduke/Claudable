import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; orgId: string },
  mayUse: false,
}));

vi.mock('@/lib/auth/session', () => ({ getSessionUser: vi.fn(async () => state.user) }));
vi.mock('@/lib/services/tenant-policy', () => ({ mayUseOwnToken: vi.fn(async () => state.mayUse) }));
vi.mock('@/lib/services/claude-credentials', () => ({
  listMyCredentials: vi.fn(async () => [{ id: 'c1', label: 'Mine', isMine: true }]),
  listOrgCredentials: vi.fn(async () => []),
  saveCredential: vi.fn(async () => ({ id: 'new' })),
}));

import { GET } from '@/app/api/claude-credentials/route';

describe('GET /api/claude-credentials', () => {
  beforeEach(() => {
    state.user = { id: 'u1', role: 'user', orgId: 'o1' };
    state.mayUse = false;
  });

  it('keeps data as the credential array and reports mayUseOwnToken=false for a forbidden customer', async () => {
    const res = await GET();
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.mayUseOwnToken).toBe(false);
  });

  it('reports mayUseOwnToken=true when allowed', async () => {
    state.mayUse = true;
    const json = await (await GET()).json();
    expect(json.mayUseOwnToken).toBe(true);
  });

  it('401s without a session', async () => {
    state.user = null;
    expect((await GET()).status).toBe(401);
  });
});
