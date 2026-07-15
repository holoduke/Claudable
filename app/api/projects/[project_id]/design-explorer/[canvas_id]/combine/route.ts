/**
 * POST /api/projects/[project_id]/design-explorer/[canvas_id]/combine
 *   { frameIds: [a, b], instruction? }
 * Create a NEW design that blends two chosen frames (a fresh lineage root, style
 * "Combined"). The two source mockups are embedded (truncated) in the frame's
 * self-contained prompt, so ordinary generation produces the hybrid.
 */
import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getSessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { generateFrames } from '@/lib/services/design-explorer/generate';
import { serializeDesignFrame } from '@/lib/serializers/design-explorer';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';
import { bodyTooLarge, SMALL_JSON_LIMIT } from '@/lib/utils/request-size';

interface RouteContext { params: Promise<{ project_id: string; canvas_id: string }>; }

const MAX_SRC = 8000; // chars of each source HTML to embed

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, canvas_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (_gate) return _gate;
    if (bodyTooLarge(request, SMALL_JSON_LIMIT)) return createErrorResponse('too_large', 'Request too large', 413);

    const body = (await request.json().catch(() => null)) ?? {};
    const ids: string[] = Array.isArray(body.frameIds) ? body.frameIds.filter((x: unknown): x is string => typeof x === 'string') : [];
    if (ids.length !== 2) return createErrorResponse('invalid', 'Pick exactly two designs to combine', 400);
    if (ids[0] === ids[1]) return createErrorResponse('invalid', 'Pick two different designs to combine', 400);
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';

    const canvas = await prisma.designCanvas.findFirst({ where: { id: canvas_id, projectId: project_id } });
    if (!canvas) return createErrorResponse('not_found', 'Canvas not found', 404);

    const [a, b] = await Promise.all(ids.map((id) => prisma.designFrame.findFirst({ where: { id, canvasId: canvas_id } })));
    if (!a || !b || !a.htmlPath || !b.htmlPath) return createErrorResponse('invalid', 'Both designs must be ready to combine', 400);
    const [htmlA, htmlB] = await Promise.all([fs.readFile(a.htmlPath, 'utf8'), fs.readFile(b.htmlPath, 'utf8')]);

    const combinePrompt = [
      canvas.prompt,
      '',
      'Create ONE new design that COMBINES the two references below into a single coherent page.',
      instruction
        ? `Guidance: ${instruction}`
        : `Take the strongest layout and structure from Reference A and the palette, typography and mood from Reference B.`,
      '',
      `Reference A (${a.styleName || 'A'}):`,
      '```html',
      htmlA.slice(0, MAX_SRC),
      '```',
      '',
      `Reference B (${b.styleName || 'B'}):`,
      '```html',
      htmlB.slice(0, MAX_SRC),
      '```',
    ].join('\n').slice(0, 16000); // cap the assembled prompt (two 8k sources + brief)

    const frame = await prisma.designFrame.create({
      data: { canvasId: canvas_id, styleId: null, styleName: 'Combined', prompt: combinePrompt, status: 'pending' },
    });
    await prisma.designCanvas.update({ where: { id: canvas_id }, data: { status: 'generating' } });

    const requester = await getSessionUser();
    void generateFrames(project_id, [frame.id], requester?.id).catch((e) => {
      console.error('[DesignExplorer] combine failed:', e);
    });

    return createSuccessResponse(serializeDesignFrame(frame), 201);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to combine designs');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
