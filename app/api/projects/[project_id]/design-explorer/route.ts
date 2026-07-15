/**
 * GET /api/projects/[project_id]/design-explorer
 * List the project's design canvases (newest first) with frame metadata only
 * (the mockup HTML is fetched per-frame via the html endpoint).
 */
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { prisma } from '@/lib/db/client';
import { serializeDesignCanvas } from '@/lib/serializers/design-explorer';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';

interface RouteContext { params: Promise<{ project_id: string }>; }

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id);
    if (_gate) return _gate;

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
