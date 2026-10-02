/**
 * PUBLIC (the share token is the credential): is this share's preview actually
 * reachable yet? The share page polls this while the dev server warms up — the
 * cross-origin iframe can't tell a working app from the proxy's "Bad Gateway"
 * page, so the overlay/retry loop must be driven by a server-side probe.
 *
 * Deliberately reveals nothing beyond `{ ready: boolean }` (no status, port or
 * error detail) to guests.
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveShareToken } from '@/lib/services/shares';
import { previewManager } from '@/lib/services/preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROBE_TIMEOUT_MS = 2_500;

interface RouteContext {
  params: Promise<{ token: string }>;
}

/** Direct probe of the dev server (same target/semantics as preview/health). */
async function previewReachable(projectId: string): Promise<boolean> {
  const status = previewManager.getStatus(projectId);
  if (status.status !== 'running' || !status.port) return false;
  const publishHost =
    (process.env.PREVIEW_PUBLISH_HOST || process.env.DEPLOY_HOST_GATEWAY || '').trim() || 'localhost';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${publishHost}:${status.port}/`, { signal: ctrl.signal, redirect: 'manual' });
    // ANY response = the server is up (no proxy in this path, so a 5xx is the
    // app itself rendering an error the reviewer should see). Only transport
    // failure/timeout means "not yet".
    res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const noStore = { headers: { 'Cache-Control': 'no-store' } };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { token } = await params;
    const projectId = await resolveShareToken(token);
    if (!projectId) {
      return NextResponse.json({ success: false, error: 'invalid_token', message: 'This share link is invalid or has been revoked' }, { status: 404, ...noStore });
    }
    const ready = await previewReachable(projectId);
    return NextResponse.json({ success: true, data: { ready } }, noStore);
  } catch (error) {
    console.error('[API] Share readiness probe failed:', error);
    // Not-ready is the safe answer: the page keeps its overlay and polls again.
    return NextResponse.json({ success: true, data: { ready: false } }, noStore);
  }
}
