/**
 * GET /api/mcp-oauth/callback?code=…&state=…
 * The OAuth provider redirects the user's browser here after they authorize.
 * We match the single-use `state` to the pending MCP server, exchange the code
 * for tokens, then bounce back to the project. No session gate — the unguessable,
 * single-use `state` is the CSRF protection (standard OAuth callback pattern).
 *
 * Failures (provider error / user denied / unknown or expired state / token
 * exchange) also go back to the ORIGINATING project chat when the pending state
 * identifies it, with ?mcp_auth=error&mcp_auth_msg=… for the chat to show.
 */
import { NextRequest, NextResponse } from 'next/server';
import { completeOAuth } from '@/lib/services/mcp-oauth';
import { prisma } from '@/lib/db/client';

const MAX_MSG_LENGTH = 300;

function backTo(origin: string, projectId: string | null, result: 'success' | 'error', msg?: string): NextResponse {
  // NextResponse.redirect needs an absolute URL: fall back to the request origin.
  const base = (process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL || origin).trim().replace(/\/+$/, '');
  const dest = projectId
    ? `${base}/${projectId}/chat?mcp_auth=${result}${msg ? `&mcp_auth_msg=${encodeURIComponent(msg)}` : ''}`
    : `${base}/?mcp_auth=${result}${msg ? `&mcp_auth_msg=${encodeURIComponent(msg)}` : ''}`;
  return NextResponse.redirect(dest);
}

/** The project that started the flow, from its pending single-use state (null if unknown). */
async function projectForState(state: string | null): Promise<string | null> {
  if (!state) return null;
  try {
    const server = await prisma.projectMcpServer.findFirst({ where: { oauthState: state }, select: { projectId: true } });
    return server?.projectId ?? null;
  } catch (error) {
    console.error('[mcp-oauth] state lookup failed:', error);
    return null;
  }
}

/** A denied/failed flow must not leave a reusable pending state behind. */
async function clearPendingState(state: string): Promise<void> {
  try {
    await prisma.projectMcpServer.updateMany({ where: { oauthState: state }, data: { oauthState: null, oauthPkceEnc: null } });
  } catch (error) {
    console.error('[mcp-oauth] clearing pending state failed:', error);
  }
}

const shorten = (msg: string): string => (msg.length > MAX_MSG_LENGTH ? `${msg.slice(0, MAX_MSG_LENGTH)}…` : msg);

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');

  // Resolve the originating project BEFORE completing/clearing the state.
  const projectId = await projectForState(state);

  if (providerError) {
    if (state) await clearPendingState(state);
    const msg = providerError === 'access_denied'
      ? 'Authorization was denied.'
      : url.searchParams.get('error_description') || providerError;
    return backTo(url.origin, projectId, 'error', shorten(msg));
  }
  if (!code || !state) return backTo(url.origin, projectId, 'error', 'Missing code or state');

  try {
    const done = await completeOAuth(state, code);
    return backTo(url.origin, done.projectId, 'success');
  } catch (error) {
    console.error('[mcp-oauth] callback failed:', error);
    return backTo(url.origin, projectId, 'error', shorten(error instanceof Error ? error.message : 'Authentication failed'));
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
