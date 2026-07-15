/**
 * GET /api/projects/[project_id]/design-explorer
 * List the project's design canvases (newest first) with frame metadata only
 * (the mockup HTML is fetched per-frame via the html endpoint).
 */
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { prisma } from '@/lib/db/client';
import { serializeDesignCanvas } from '@/lib/serializers/design-explorer';
import { sweepOrphanedCanvasScratch } from '@/lib/services/design-explorer/cleanup';
import { recoverStuckFrames } from '@/lib/services/design-explorer/generate';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';

// Best-effort reclaim of scratch dirs whose canvas is gone (crash/redeploy
// orphans). Fire-and-forget on list — cheap and self-throttling by traffic.
let lastSweep = 0;

interface RouteContext { params: Promise<{ project_id: string }>; }

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id);
    if (_gate) return _gate;

    // At most once per hour across the process — avoids scanning on every list.
    const now = Date.now();
    if (now - lastSweep > 60 * 60 * 1000) {
      lastSweep = now;
      void sweepOrphanedCanvasScratch().catch(() => {});
      void recoverStuckFrames().catch(() => {}); // un-stick frames orphaned by a restart
    }

    const canvases = await prisma.designCanvas.findMany({
      where: { projectId: project_id },
      orderBy: { createdAt: 'desc' },
      include: { frames: { orderBy: { createdAt: 'asc' } } },
    });
    return createSuccessResponse(canvases.map(serializeDesignCanvas));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list design canvases');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
