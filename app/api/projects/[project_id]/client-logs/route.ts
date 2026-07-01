/**
 * Ingest browser-console diagnostics shipped by the injected preview plugin.
 *
 * The plugin (running inside the preview iframe, a different origin) POSTs
 * batches here as text/plain — a CORS "simple" request, so no preflight and no
 * response is read. We just buffer the entries server-side per project so the
 * agent can later ask "what console errors is this app throwing?".
 *
 * No auth: this is preview telemetry on a VPN-gated box; we only accept it for
 * projects that exist, and every field is length-capped in recordConsole.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { recordConsole } from '@/lib/services/diagnostics';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    // Reject oversized bodies before reading them into memory — this endpoint is
    // unauthenticated (preview telemetry), so cap the blast radius of a bad/hostile client.
    const declaredLen = Number(request.headers.get('content-length') || '0');
    if (Number.isFinite(declaredLen) && declaredLen > 64 * 1024) return new Response(null, { status: 204 });

    const project = await prisma.project.findUnique({ where: { id: project_id }, select: { id: true } });
    if (!project) return new Response(null, { status: 204 }); // silently drop; plugin ignores the response

    const raw = (await request.text().catch(() => '')).slice(0, 64 * 1024);
    let parsed: unknown = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    const entries = parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: Array<{ level?: unknown; message?: unknown; at?: unknown }> }).entries
      : [];
    if (entries.length) recordConsole(project_id, entries);
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 204 });
  }
}
