import { describe, it, expect, vi } from 'vitest';
import { shouldRedirectOnUnauthorized, buildLoginUrl, isPublicPage, installSessionGuard } from './session-guard';

const ORIGIN = 'https://claudable.example';
const base = { status: 401, origin: ORIGIN, pathname: '/project-1/chat', authEnabled: true };

describe('shouldRedirectOnUnauthorized', () => {
  it('redirects on a 401 from an authenticated same-origin API call', () => {
    expect(shouldRedirectOnUnauthorized({ ...base, requestUrl: '/api/projects' })).toBe(true);
    expect(shouldRedirectOnUnauthorized({ ...base, requestUrl: `${ORIGIN}/api/chat/p1/act` })).toBe(true);
  });

  it('is a no-op when auth is disabled', () => {
    expect(shouldRedirectOnUnauthorized({ ...base, authEnabled: false, requestUrl: '/api/projects' })).toBe(false);
  });

  it('ignores non-401 statuses', () => {
    expect(shouldRedirectOnUnauthorized({ ...base, status: 403, requestUrl: '/api/projects' })).toBe(false);
    expect(shouldRedirectOnUnauthorized({ ...base, status: 200, requestUrl: '/api/projects' })).toBe(false);
  });

  it('ignores auth, share, guest-comment and other public endpoints', () => {
    for (const url of ['/api/auth/session', '/api/auth', '/api/share/abc', '/api/share/abc/ready', '/api/health',
      '/api/projects/p1/comments', '/api/projects/p1/comments/c1', '/api/projects/p1/client-logs', '/api/agent-mcp/tok']) {
      expect(shouldRedirectOnUnauthorized({ ...base, requestUrl: url })).toBe(false);
    }
  });

  it('ignores calls made from public pages (login, share, privacy)', () => {
    for (const pathname of ['/login', '/login/verify', '/share/tok', '/privacy']) {
      expect(shouldRedirectOnUnauthorized({ ...base, pathname, requestUrl: '/api/users/me' })).toBe(false);
    }
  });

  it('ignores cross-origin and non-API requests', () => {
    expect(shouldRedirectOnUnauthorized({ ...base, requestUrl: 'https://preview.example/api/x' })).toBe(false);
    expect(shouldRedirectOnUnauthorized({ ...base, requestUrl: '/project-1/chat' })).toBe(false);
  });

  it('does not treat lookalike paths as public', () => {
    expect(shouldRedirectOnUnauthorized({ ...base, requestUrl: '/api/authors' })).toBe(true);
    expect(isPublicPage('/privacy-settings')).toBe(false);
    expect(isPublicPage('/sharepoint')).toBe(false);
  });
});

describe('buildLoginUrl', () => {
  it('encodes the current path, query and hash', () => {
    expect(buildLoginUrl('/p1/chat', '?model=x', '#a')).toBe('/login?callbackUrl=%2Fp1%2Fchat%3Fmodel%3Dx%23a');
  });

  it('never produces an off-site callback', () => {
    expect(buildLoginUrl('//evil.example')).toBe('/login?callbackUrl=%2F');
    expect(buildLoginUrl('')).toBe('/login?callbackUrl=%2F');
  });
});

describe('installSessionGuard', () => {
  function fakeWindow(status: number, authEnabled: boolean) {
    const assign = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/auth/config') return new Response(JSON.stringify({ success: true, data: { authEnabled } }));
      return new Response('{}', { status });
    });
    const win = { fetch: fetchMock, location: { origin: ORIGIN, pathname: '/p1/chat', search: '', hash: '', assign } };
    return { win: win as unknown as Window, assign, fetchMock };
  }

  it('redirects once on repeated 401s and restores fetch on uninstall', async () => {
    const { win, assign, fetchMock } = fakeWindow(401, true);
    const uninstall = installSessionGuard(win);
    const r1 = await win.fetch('/api/projects');
    await win.fetch('/api/projects/p1');
    await new Promise((r) => setTimeout(r, 0));
    expect(r1.status).toBe(401);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/login?callbackUrl=%2Fp1%2Fchat');
    uninstall();
    expect(win.fetch).not.toBe(fetchMock); // bound original
  });
});
