/**
 * GET    /api/projects/[project_id]/design-explorer/[canvas_id]  — one canvas + frames
 * DELETE /api/projects/[project_id]/design-explorer/[canvas_id]  — remove (cascade + scratch)
 */
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { prisma } from '@/lib/db/client';
import { serializeDesignCanvas } from '@/lib/serializers/design-explorer';
import { removeCanvasScratch } from '@/lib/services/design-explorer/cleanup';
import { cancelFrames, clearCancelled } from '@/lib/services/design-explorer/generate';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

interface RouteContext { params: Promise<{ project_id: string; canvas_id: string }>; }

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id, canvas_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id);
    if (_gate) return _gate;
    const canvas = await prisma.designCanvas.findFirst({
      where: { id: canvas_id, projectId: project_id },
      include: { frames: { orderBy: { createdAt: 'asc' } } },
    });
    if (!canvas) return createErrorResponse('not_found', 'Canvas not found', 404);
    return createSuccessResponse(serializeDesignCanvas(canvas));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to fetch canvas');
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  try {
    const { project_id, canvas_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (_gate) return _gate;
    const canvas = await prisma.designCanvas.findFirst({
      where: { id: canvas_id, projectId: project_id },
      include: { frames: { select: { id: true } } },
    });
    if (!canvas) return createErrorResponse('not_found', 'Canvas not found', 404);
    // Hard-stop any still-running generation BEFORE removing rows + scratch, so
    // we don't orphan containers that keep writing into a deleted dir.
    const frameIds = canvas.frames.map((f) => f.id);
    cancelFrames(frameIds);
    await prisma.designCanvas.delete({ where: { id: canvas_id } }); // frames cascade
    clearCancelled(frameIds); // rows are gone now — safe to purge the markers
    await removeCanvasScratch(canvas_id);
    return createSuccessResponse({ deleted: true });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to delete canvas');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
