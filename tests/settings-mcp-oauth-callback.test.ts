import { beforeEach, describe, expect, it, vi } from 'vitest';

// The MCP OAuth callback must bounce every outcome — success AND failure —
// back to the project chat that started the flow, with mcp_auth params the
// chat page turns into a toast.
const servers: { projectId: string; oauthState: string | null }[] = [];

vi.mock('@/lib/db/client', () => ({
  prisma: {
    projectMcpServer: {
      findFirst: vi.fn(async ({ where }: { where: { oauthState: string } }) =>
        servers.find((s) => s.oauthState === where.oauthState) ?? null),
      updateMany: vi.fn(async ({ where }: { where: { oauthState: string } }) => {
        const hit = servers.filter((s) => s.oauthState === where.oauthState);
        hit.forEach((s) => { s.oauthState = null; });
        return { count: hit.length };
      }),
    },
  },
}));
const completeOAuth = vi.fn();
vi.mock('@/lib/services/mcp-oauth', () => ({ completeOAuth: (...a: unknown[]) => completeOAuth(...a) }));

import { GET } from '@/app/api/mcp-oauth/callback/route';

const call = async (qs: string) => {
  const res = await GET(new Request(`http://localhost/api/mcp-oauth/callback?${qs}`) as never);
  return new URL(res.headers.get('location') ?? '', 'http://x');
};

beforeEach(() => {
  servers.length = 0;
  servers.push({ projectId: 'proj-1', oauthState: 'st-1' });
  completeOAuth.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('GET /api/mcp-oauth/callback', () => {
  it('success → project chat with mcp_auth=success', async () => {
    completeOAuth.mockResolvedValue({ projectId: 'proj-1' });
    const loc = await call('code=c&state=st-1');
    expect(loc.pathname).toBe('/proj-1/chat');
    expect(loc.searchParams.get('mcp_auth')).toBe('success');
  });

  it('user denied → originating chat with an error message, pending state cleared', async () => {
    const loc = await call('error=access_denied&state=st-1');
    expect(loc.pathname).toBe('/proj-1/chat');
    expect(loc.searchParams.get('mcp_auth')).toBe('error');
    expect(loc.searchParams.get('mcp_auth_msg')).toMatch(/denied/i);
    expect(servers[0].oauthState).toBeNull();
    expect(completeOAuth).not.toHaveBeenCalled();
  });

  it('token exchange failure → originating chat with the error', async () => {
    completeOAuth.mockRejectedValue(new Error('Token exchange failed (400)'));
    const loc = await call('code=c&state=st-1');
    expect(loc.pathname).toBe('/proj-1/chat');
    expect(loc.searchParams.get('mcp_auth_msg')).toBe('Token exchange failed (400)');
  });

  it('unknown/expired state → home, still with a message', async () => {
    completeOAuth.mockRejectedValue(new Error('Unknown or expired OAuth state.'));
    const loc = await call('code=c&state=nope');
    expect(loc.pathname).toBe('/');
    expect(loc.searchParams.get('mcp_auth')).toBe('error');
    expect(loc.searchParams.get('mcp_auth_msg')).toMatch(/expired/);
  });
});
