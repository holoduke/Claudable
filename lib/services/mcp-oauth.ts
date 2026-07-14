/**
 * MCP OAuth (MCP authorization spec — OAuth 2.1 + PKCE + Dynamic Client
 * Registration). Claudable owns the whole flow and stores the resulting token
 * on the ProjectMcpServer row (encrypted); buildProjectMcpConfig then injects
 * `Authorization: Bearer <token>` into the agent's mcp-config for BOTH the
 * in-process and containerized paths. The agent never sees the OAuth dance.
 *
 * Flow:
 *   1. probe    — POST initialize to the MCP URL; a 401 + WWW-Authenticate with
 *                 resource_metadata means the server needs OAuth.
 *   2. discover — .well-known/oauth-protected-resource → authorization server →
 *                 .well-known/oauth-authorization-server (endpoints + scopes).
 *   3. register — RFC 7591 dynamic client registration (or a pre-set client_id).
 *   4. authorize— redirect the user to the auth endpoint (PKCE S256 + state).
 *   5. callback — exchange code+verifier at the token endpoint → store tokens.
 *   6. refresh  — refresh the access token when near expiry (per-turn build hook).
 */
import { prisma } from '@/lib/db/client';
import { encrypt, decrypt } from '@/lib/crypto';
import { assertHostAllowed } from '@/lib/services/itops/net';
import { createHash, randomBytes } from 'crypto';
import type { ProjectMcpServer } from '@prisma/client';

export interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  resource?: string;
  scopes?: string[];
}
export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  scope?: string;
  token_type?: string;
}
export type McpAuthStatus = 'none' | 'needs-auth' | 'connected' | 'expired';

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function appBaseUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('NEXT_PUBLIC_APP_URL is not set — cannot build the OAuth redirect URI.');
  return raw;
}
export function callbackUri(): string {
  return `${appBaseUrl()}/api/mcp-oauth/callback`;
}

async function guardedFetch(url: string, init?: RequestInit): Promise<Response> {
  // SSRF guard. Validating only the initial host is not enough: with the default
  // redirect:follow, a hostile endpoint can 302 → http://169.254.169.254 (IMDS)
  // or an RFC-1918 host and the guard is bypassed. So follow redirects MANUALLY,
  // re-validating https + the host on every hop (bounded).
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:') throw new Error(`OAuth endpoint must be https: ${current}`);
    await assertHostAllowed(u.hostname);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location) return res; // redirect without a target — hand back as-is
    current = new URL(location, current).toString(); // resolve relative redirects
  }
  throw new Error(`Too many redirects fetching OAuth endpoint: ${url}`);
}

/** POST a JSON-RPC initialize and read whether the server demands OAuth. */
export async function probeMcpAuth(
  url: string,
  headers?: Record<string, string>,
): Promise<{ requiresAuth: boolean; resourceMetadataUrl?: string }> {
  let res: Response;
  try {
    res = await guardedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(headers || {}) },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claudable', version: '1' } },
      }),
    });
  } catch {
    return { requiresAuth: false }; // unreachable → treat as "no auth known"
  }
  if (res.status !== 401) return { requiresAuth: false };
  const www = res.headers.get('www-authenticate') || '';
  const m = www.match(/resource_metadata="([^"]+)"/i);
  return { requiresAuth: true, resourceMetadataUrl: m?.[1] };
}

/** Resolve the OAuth endpoints for an MCP URL via the well-known metadata. */
export async function discoverMetadata(mcpUrl: string, resourceMetadataUrl?: string): Promise<OAuthMetadata> {
  const base = new URL(mcpUrl);
  const prmUrl = resourceMetadataUrl || `${base.origin}/.well-known/oauth-protected-resource`;
  let authServer = base.origin;
  let scopes: string[] | undefined;
  let resource: string | undefined;
  try {
    const prm = await guardedFetch(prmUrl).then((r) => (r.ok ? r.json() : null));
    if (prm) {
      resource = prm.resource;
      scopes = prm.scopes_supported;
      if (Array.isArray(prm.authorization_servers) && prm.authorization_servers[0]) authServer = prm.authorization_servers[0];
    }
  } catch { /* fall back to the MCP origin as the auth server */ }

  const asOrigin = authServer.replace(/\/+$/, '');
  let meta: Record<string, unknown> | null = null;
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    try {
      const r = await guardedFetch(asOrigin + path);
      if (r.ok) { meta = await r.json(); break; }
    } catch { /* try next */ }
  }
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) {
    throw new Error('Could not discover the OAuth authorization/token endpoints for this MCP server.');
  }
  return {
    authorization_endpoint: String(meta.authorization_endpoint),
    token_endpoint: String(meta.token_endpoint),
    registration_endpoint: meta.registration_endpoint ? String(meta.registration_endpoint) : undefined,
    resource: resource || String((meta as { resource?: string }).resource || mcpUrl),
    scopes,
  };
}

/** RFC 7591 dynamic client registration. Returns a public (PKCE) client. */
async function registerClient(meta: OAuthMetadata): Promise<{ clientId: string; clientSecret?: string }> {
  if (!meta.registration_endpoint) {
    throw new Error('This MCP provider does not support dynamic registration — set a client_id manually.');
  }
  const res = await guardedFetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claudable',
      redirect_uris: [callbackUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(meta.scopes?.length ? { scope: meta.scopes.join(' ') } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Client registration failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (!j.client_id) throw new Error('Client registration returned no client_id.');
  return { clientId: String(j.client_id), clientSecret: j.client_secret ? String(j.client_secret) : undefined };
}

/**
 * Begin the OAuth flow for a server: discover, register (if needed), generate
 * PKCE + state, persist them, and return the authorization URL to redirect to.
 */
export async function startOAuth(server: ProjectMcpServer): Promise<{ authUrl: string }> {
  if (!server.url) throw new Error('OAuth is only for remote (http/sse) MCP servers.');
  const probe = await probeMcpAuth(server.url);
  const meta = await discoverMetadata(server.url, probe.resourceMetadataUrl);

  let clientId = server.oauthClientId ?? undefined;
  let clientSecret = server.oauthClientSecretEnc ? decrypt(server.oauthClientSecretEnc) : undefined;
  if (!clientId) {
    const reg = await registerClient(meta);
    clientId = reg.clientId;
    clientSecret = reg.clientSecret;
  }

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(24));

  await prisma.projectMcpServer.update({
    where: { id: server.id },
    data: {
      authType: 'oauth',
      oauthMetadataJson: JSON.stringify(meta),
      oauthClientId: clientId,
      oauthClientSecretEnc: clientSecret ? encrypt(clientSecret) : null,
      oauthPkceEnc: encrypt(verifier),
      oauthState: state,
    },
  });

  const p = new URLSearchParams({
    response_type: 'code',
    client_id: clientId!,
    redirect_uri: callbackUri(),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  if (meta.resource) p.set('resource', meta.resource);
  if (meta.scopes?.length) p.set('scope', meta.scopes.join(' '));
  return { authUrl: `${meta.authorization_endpoint}?${p.toString()}` };
}

/** Handle the OAuth redirect: match by state, exchange the code for tokens. */
export async function completeOAuth(state: string, code: string): Promise<{ projectId: string }> {
  const server = await prisma.projectMcpServer.findFirst({ where: { oauthState: state } });
  if (!server) throw new Error('Unknown or expired OAuth state.');
  const meta = JSON.parse(server.oauthMetadataJson || '{}') as OAuthMetadata;
  const verifier = server.oauthPkceEnc ? decrypt(server.oauthPkceEnc) : '';
  if (!meta.token_endpoint || !verifier || !server.oauthClientId) throw new Error('OAuth session is incomplete — restart authentication.');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUri(),
    client_id: server.oauthClientId,
    code_verifier: verifier,
  });
  if (meta.resource) body.set('resource', meta.resource);
  if (server.oauthClientSecretEnc) body.set('client_secret', decrypt(server.oauthClientSecretEnc));

  const res = await guardedFetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const tokens: OAuthTokens = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined,
    scope: j.scope, token_type: j.token_type,
  };
  await prisma.projectMcpServer.update({
    where: { id: server.id },
    data: { oauthTokensEnc: encrypt(JSON.stringify(tokens)), oauthPkceEnc: null, oauthState: null, oauthConnectedAt: new Date() },
  });
  return { projectId: server.projectId };
}

async function refresh(server: ProjectMcpServer, tokens: OAuthTokens): Promise<OAuthTokens | null> {
  if (!tokens.refresh_token) return null;
  const meta = JSON.parse(server.oauthMetadataJson || '{}') as OAuthMetadata;
  if (!meta.token_endpoint || !server.oauthClientId) return null;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: server.oauthClientId });
  if (server.oauthClientSecretEnc) body.set('client_secret', decrypt(server.oauthClientSecretEnc));
  const res = await guardedFetch(meta.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString(),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const j = await res.json();
  const next: OAuthTokens = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || tokens.refresh_token,
    expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined,
    scope: j.scope || tokens.scope, token_type: j.token_type || tokens.token_type,
  };
  await prisma.projectMcpServer.update({ where: { id: server.id }, data: { oauthTokensEnc: encrypt(JSON.stringify(next)) } });
  return next;
}

/** Valid Bearer access token for a server, refreshing when near expiry. null if not authenticated. */
export async function getValidAccessToken(server: ProjectMcpServer): Promise<string | null> {
  if (server.authType !== 'oauth' || !server.oauthTokensEnc) return null;
  let tokens: OAuthTokens;
  try { tokens = JSON.parse(decrypt(server.oauthTokensEnc)); } catch { return null; }
  if (tokens.expires_at && tokens.expires_at - Date.now() < 60_000) {
    const refreshed = await refresh(server, tokens);
    if (refreshed) tokens = refreshed;
  }
  return tokens.access_token || null;
}

/** Auth status for the UI / /mcp command (no network call — uses stored state). */
export function authStatusOf(server: ProjectMcpServer): McpAuthStatus {
  if (server.authType !== 'oauth') return 'none';
  if (!server.oauthTokensEnc) return 'needs-auth';
  try {
    const t = JSON.parse(decrypt(server.oauthTokensEnc)) as OAuthTokens;
    if (t.expires_at && t.expires_at < Date.now() && !t.refresh_token) return 'expired';
  } catch { return 'needs-auth'; }
  return 'connected';
}

export async function disconnectOAuth(projectId: string, id: string): Promise<boolean> {
  const res = await prisma.projectMcpServer.updateMany({
    where: { id, projectId },
    data: { oauthTokensEnc: null, oauthPkceEnc: null, oauthState: null, oauthConnectedAt: null },
  });
  return res.count > 0;
}
