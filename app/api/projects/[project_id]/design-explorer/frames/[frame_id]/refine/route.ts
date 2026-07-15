/**
 * POST /api/projects/[project_id]/design-explorer/frames/[frame_id]/refine
 * Create a new child frame (a refined version of the given one) and regenerate
 * it with an augmented brief. Returns the new pending frame; progress via SSE.
 */
import { NextRequest } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getSessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { generateFrames } from '@/lib/services/design-explorer/generate';
import { serializeDesignFrame } from '@/lib/serializers/design-explorer';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';
import { readJsonCapped, BodyTooLargeError, SMALL_JSON_LIMIT } from '@/lib/utils/request-size';

interface RouteContext { params: Promise<{ project_id: string; frame_id: string }>; }

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, frame_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (_gate) return _gate;
    let body: Record<string, unknown>;
    try {
      body = ((await readJsonCapped(request, SMALL_JSON_LIMIT)) as Record<string, unknown> | null) ?? {};
    } catch (e) {
      if (e instanceof BodyTooLargeError) return createErrorResponse('too_large', 'Request too large', 413);
      throw e;
    }
    const refinement = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!refinement) return createErrorResponse('invalid', 'A refinement instruction is required', 400);
    if (refinement.length > 2000) return createErrorResponse('invalid', 'Refinement is too long (max 2000 characters)', 400);

    const parent = await prisma.designFrame.findUnique({
      where: { id: frame_id },
      include: { canvas: { select: { projectId: true } } },
    });
    if (!parent || parent.canvas.projectId !== project_id) {
      return createErrorResponse('not_found', 'Frame not found', 404);
    }

    // The refined brief keeps the original direction and layers the change on top.
    // Cap total length so a deep refine chain can't grow the prompt unboundedly.
    const newPrompt = `${parent.prompt}\n\nRefine the previous design: ${refinement}`.slice(0, 12000);
    const child = await prisma.designFrame.create({
      data: {
        canvasId: parent.canvasId,
        styleId: parent.styleId,
        styleName: parent.styleName,
        prompt: newPrompt,
        status: 'pending',
        version: parent.version + 1,
        parentFrameId: parent.id,
      },
    });
    // Reflect that the canvas is working again (generateFrames reconciles to
    // 'ready' when this settles).
    await prisma.designCanvas.update({ where: { id: parent.canvasId }, data: { status: 'generating' } }).catch(() => {});

    const requester = await getSessionUser();
    void generateFrames(project_id, [child.id], requester?.id).catch((e) => {
      console.error('[DesignExplorer] refine failed:', e);
    });

    return createSuccessResponse(serializeDesignFrame(child), 201);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to refine design');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
