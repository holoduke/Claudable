import { describe, expect, it, vi } from 'vitest';

// Token management needs a real session and, for changes, a same-origin request.
const auth = vi.hoisted(() => ({ current: null as null | { user: { id: string }; via: 'session' | 'token' } }));
vi.mock('./session', () => ({ getRequestAuth: vi.fn(async () => auth.current) }));

import { tokenManager } from './api-token-route';

const req = (site?: string) => new Request('https://app.test/api/users/me/api-tokens', { headers: site ? { 'sec-fetch-site': site } : {} });

describe('tokenManager', () => {
  it('allows a session, refuses an API token', async () => {
    auth.current = { user: { id: 'u1' }, via: 'session' };
    expect((await tokenManager(req('same-origin'), { mutation: true }))?.id).toBe('u1');
    auth.current = { user: { id: 'u1' }, via: 'token' };
    expect(await tokenManager(req(), { mutation: false })).toBeNull();
  });

  it('refuses cross-site changes but allows cross-site reads and header-less clients', async () => {
    auth.current = { user: { id: 'u1' }, via: 'session' };
    expect(await tokenManager(req('cross-site'), { mutation: true })).toBeNull();
    expect(await tokenManager(req('same-site'), { mutation: true })).toBeNull();
    expect((await tokenManager(req('cross-site'), { mutation: false }))?.id).toBe('u1');
    expect((await tokenManager(req(), { mutation: true }))?.id).toBe('u1');
  });
});
