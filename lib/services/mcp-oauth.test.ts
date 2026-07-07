import { describe, it, expect } from 'vitest';
import { authStatusOf, type OAuthTokens } from './mcp-oauth';
import { encrypt } from '@/lib/crypto';
import type { ProjectMcpServer } from '@prisma/client';

function row(partial: Partial<ProjectMcpServer>): ProjectMcpServer {
  return {
    id: 'x', projectId: 'p', name: 'relume', label: 'Relume', transport: 'http',
    url: 'https://relume-library-mcp.relume.io/mcp', command: null, argsJson: null,
    headersEncrypted: null, envEncrypted: null, enabled: true,
    authType: null, oauthMetadataJson: null, oauthClientId: null, oauthClientSecretEnc: null,
    oauthTokensEnc: null, oauthPkceEnc: null, oauthState: null, oauthConnectedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...partial,
  } as ProjectMcpServer;
}

describe('authStatusOf', () => {
  it('non-oauth server → none', () => {
    expect(authStatusOf(row({ authType: null }))).toBe('none');
  });
  it('oauth without token → needs-auth', () => {
    expect(authStatusOf(row({ authType: 'oauth', oauthTokensEnc: null }))).toBe('needs-auth');
  });
  it('oauth with valid token → connected', () => {
    const t: OAuthTokens = { access_token: 'abc', expires_at: Date.now() + 3_600_000 };
    expect(authStatusOf(row({ authType: 'oauth', oauthTokensEnc: encrypt(JSON.stringify(t)) }))).toBe('connected');
  });
  it('oauth expired without refresh → expired', () => {
    const t: OAuthTokens = { access_token: 'abc', expires_at: Date.now() - 1000 };
    expect(authStatusOf(row({ authType: 'oauth', oauthTokensEnc: encrypt(JSON.stringify(t)) }))).toBe('expired');
  });
  it('oauth expired WITH refresh token → still connected (will refresh)', () => {
    const t: OAuthTokens = { access_token: 'abc', refresh_token: 'r', expires_at: Date.now() - 1000 };
    expect(authStatusOf(row({ authType: 'oauth', oauthTokensEnc: encrypt(JSON.stringify(t)) }))).toBe('connected');
  });
});

// Live integration against the real Relume MCP. Guarded so normal CI never hits
// the network — run with: LIVE_MCP_TEST=1 npx vitest run lib/services/mcp-oauth.test.ts
describe.runIf(process.env.LIVE_MCP_TEST === '1')('mcp-oauth live (Relume)', () => {
  const RELUME = 'https://relume-library-mcp.relume.io/mcp';
  it('probe detects OAuth requirement', async () => {
    const { probeMcpAuth } = await import('./mcp-oauth');
    const r = await probeMcpAuth(RELUME);
    expect(r.requiresAuth).toBe(true);
    expect(r.resourceMetadataUrl).toContain('oauth-protected-resource');
  }, 20_000);
  it('discovers authorization + token endpoints', async () => {
    const { discoverMetadata } = await import('./mcp-oauth');
    const m = await discoverMetadata(RELUME);
    expect(m.authorization_endpoint).toMatch(/^https:\/\//);
    expect(m.token_endpoint).toMatch(/^https:\/\//);
    expect(m.registration_endpoint).toMatch(/^https:\/\//);
  }, 20_000);
});
