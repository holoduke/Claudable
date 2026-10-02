import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { providers: [] as string[], authOn: true, admin: false };

vi.mock('@/lib/db/client', () => ({
  prisma: {
    serviceToken: {
      findMany: vi.fn(async ({ select }: any) => {
        // Only the provider column may be read — never the token itself.
        expect(select).toEqual({ provider: true });
        return state.providers.map((provider) => ({ provider }));
      }),
    },
  },
}));
vi.mock('@/lib/auth/session', () => ({
  authEnabled: () => state.authOn,
  getAdminUser: async () => (state.admin ? { id: 'a', role: 'admin' } : null),
}));

import { getServiceTokenStatus } from './token-status';

beforeEach(() => {
  state.providers = [];
  state.authOn = true;
  state.admin = false;
});

describe('getServiceTokenStatus', () => {
  it('reports configured providers as booleans only', async () => {
    state.providers = ['github'];
    const status = await getServiceTokenStatus();
    expect(status.providers).toEqual({
      github: { configured: true },
      supabase: { configured: false },
      vercel: { configured: false },
    });
    expect(JSON.stringify(status)).not.toMatch(/token"\s*:/);
  });

  it('non-admins cannot manage tokens; admins and auth-off can', async () => {
    expect((await getServiceTokenStatus()).can_manage_tokens).toBe(false);
    state.admin = true;
    expect((await getServiceTokenStatus()).can_manage_tokens).toBe(true);
    state.admin = false;
    state.authOn = false;
    expect((await getServiceTokenStatus()).can_manage_tokens).toBe(true);
  });
});
