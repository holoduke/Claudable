import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { previewManager } from '@/lib/services/preview';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/**
 * Lightweight reachability probe for the chat page's preview pane. The iframe
 * is cross-origin, so the browser can't tell a healthy page from Traefik's
 * "Bad Gateway" during a dev-server (re)start — this endpoint checks the
 * actual backend from inside, letting the UI show a friendly "restarting…"
 * overlay and auto-reload when the preview is reachable again.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const denied = await denyUnlessProjectAccess(project_id);
    if (denied) return denied;

    const status = previewManager.getStatus(project_id);
    if (status.status !== 'running' || !status.port) {
      return NextResponse.json({ success: true, data: { reachable: false, status: status.status } });
    }

    // Same target the reverse proxy uses (containerized previews publish on the
    // gateway IP, not loopback) — mirrors the thumbnail quality gate.
    const publishHost =
      (process.env.PREVIEW_PUBLISH_HOST || process.env.DEPLOY_HOST_GATEWAY || '').trim() || 'localhost';
    let reachable = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2_500);
      const res = await fetch(`http://${publishHost}:${status.port}/`, {
        signal: ctrl.signal,
        redirect: 'manual',
      }).finally(() => clearTimeout(timer));
      // Any response the APP produced counts as up (401/404/redirects included);
      // only transport failure or a 5xx from a dying server counts as down.
      reachable = res.status < 500;
    } catch {
      reachable = false;
    }

    return NextResponse.json({ success: true, data: { reachable, status: status.status } });
  } catch (error) {
    console.error('[API] Preview health probe failed:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to probe preview health' },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
