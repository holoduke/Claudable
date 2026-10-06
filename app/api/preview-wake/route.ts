/**
 * Wake-on-visit for stopped previews (see lib/services/preview/wake.ts).
 *
 * proxy.ts rewrites every request on a preview-<slug> host here. That only
 * happens while the project's own Traefik route is missing, i.e. its preview is
 * not running. Unauthenticated by design (the preview URL itself is public); the
 * wake limiter caps how many cold starts anonymous visitors can cause.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { previewManager } from '@/lib/services/preview';
import {
  WAKE_HEADER, WAKE_STATUS_PATH, createWakeLimiter, resolveWakeSlug, slugFromHost, wakePage, type WakeState,
} from '@/lib/services/preview/wake';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const allowWake = createWakeLimiter();
const NO_STORE = { 'cache-control': 'no-store', [WAKE_HEADER]: '1', 'x-robots-tag': 'noindex' };

async function findProject(host: string | null): Promise<{ projectId: string } | null> {
  const slug = slugFromHost(host, process.env.PREVIEW_URL_TEMPLATE || '');
  if (!slug) return null;
  const projects = await prisma.project.findMany({ select: { id: true } });
  return resolveWakeSlug(slug, projects.map((p) => p.id));
}

/** Current state, kicking off a start when the preview is stopped and the budget allows. */
function wake(projectId: string): WakeState | 'running' {
  const status = previewManager.getStatus(projectId).status;
  if (status === 'running') return 'running';
  if (status === 'starting') return 'starting';
  if (!allowWake(projectId)) return status === 'error' ? 'failed' : 'busy';
  console.log(`[PreviewWake] starting preview ${projectId} for a visitor of its public URL`);
  previewManager.start(projectId).catch((error) => {
    console.error(`[PreviewWake] preview ${projectId} failed to start:`, error instanceof Error ? error.message : error);
  });
  return 'starting';
}

async function handle(request: NextRequest): Promise<Response> {
  const path = request.headers.get('x-claudable-wake-path') || '/';
  try {
    const project = await findProject(request.headers.get('host'));
    const state = project ? wake(project.projectId) : 'unknown';
    if (path === WAKE_STATUS_PATH) {
      return Response.json({ state }, { headers: NO_STORE });
    }
    const page = state === 'running' ? 'starting' : state; // route not live yet: keep waiting
    const wantsHtml = request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html');
    const status = page === 'unknown' ? 404 : 503;
    if (!wantsHtml) {
      return new Response(page === 'unknown' ? 'Preview not found\n' : 'Preview is starting\n', {
        status,
        headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8', 'retry-after': '5' },
      });
    }
    return new Response(wakePage(page), {
      status,
      headers: { ...NO_STORE, 'content-type': 'text/html; charset=utf-8', 'retry-after': '5' },
    });
  } catch (error) {
    console.error('[PreviewWake] wake request failed:', error);
    return new Response('Preview unavailable\n', { status: 503, headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' } });
  }
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
