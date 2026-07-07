/**
 * GET /api/mcp-oauth/callback?code=…&state=…
 * The OAuth provider redirects the user's browser here after they authorize.
 * We match the single-use `state` to the pending MCP server, exchange the code
 * for tokens, then bounce back to the project. No session gate — the unguessable,
 * single-use `state` is the CSRF protection (standard OAuth callback pattern).
 */
import { NextRequest, NextResponse } from 'next/server';
import { completeOAuth } from '@/lib/services/mcp-oauth';

function backTo(projectId: string | null, result: 'success' | 'error', msg?: string): NextResponse {
  const base = (process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL || '').trim().replace(/\/+$/, '');
  const dest = projectId
    ? `${base}/${projectId}/chat?mcp_auth=${result}${msg ? `&mcp_auth_msg=${encodeURIComponent(msg)}` : ''}`
    : `${base}/?mcp_auth=${result}`;
  return NextResponse.redirect(dest);
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');

  if (providerError) return backTo(null, 'error', url.searchParams.get('error_description') || providerError);
  if (!code || !state) return backTo(null, 'error', 'Missing code or state');

  try {
    const { projectId } = await completeOAuth(state, code);
    return backTo(projectId, 'success');
  } catch (error) {
    console.error('[mcp-oauth] callback failed:', error);
    return backTo(null, 'error', error instanceof Error ? error.message : 'Authentication failed');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
