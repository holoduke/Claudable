/**
 * POST /api/projects/[project_id]/design-explorer/[canvas_id]/frames { count? }
 * Add more variations to an existing canvas — seeded with catalog styles NOT
 * already used on it, so "add more" broadens the exploration instead of
 * repeating directions. Returns the new pending frames; progress via SSE.
 */
import { NextRequest } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getSessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { listDesignCatalog } from '@/lib/services/design-skills';
import { generateFrames } from '@/lib/services/design-explorer/generate';
import { serializeDesignFrame } from '@/lib/serializers/design-explorer';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

interface RouteContext { params: Promise<{ project_id: string; canvas_id: string }>; }

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, canvas_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (_gate) return _gate;

    const body = (await request.json().catch(() => null)) ?? {};
    const count = Math.min(6, Math.max(1, Number.parseInt(String(body.count ?? 2), 10) || 2));

    const canvas = await prisma.designCanvas.findFirst({
      where: { id: canvas_id, projectId: project_id },
      include: { frames: true },
    });
    if (!canvas) return createErrorResponse('not_found', 'Canvas not found', 404);

    const used = new Set(canvas.frames.map((f) => f.styleId).filter(Boolean) as string[]);
    const catalog = await listDesignCatalog();
    const fresh = catalog.filter((c) => !used.has(c.id));
    // Prefer unused styles; fall back to the whole catalog if we've used them all.
    const pool = fresh.length >= count ? fresh : catalog;
    const step = pool.length > 0 ? pool.length / count : 1;
    const seeds = pool.length > 0
      ? Array.from({ length: count }, (_, i) => pool[Math.floor(i * step) % pool.length])
      : [];

    const specs = seeds.length > 0 ? seeds : [null];
    await prisma.designFrame.createMany({
      data: specs.map((seed) => ({
        canvasId: canvas.id,
        styleId: seed?.id ?? null,
        styleName: seed?.name ?? null,
        prompt: canvas.prompt,
        status: 'pending',
      })),
    });
    await prisma.designCanvas.update({ where: { id: canvas.id }, data: { status: 'generating' } });

    const added = await prisma.designFrame.findMany({
      where: { canvasId: canvas.id, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: specs.length,
    });
    const requester = await getSessionUser();
    void generateFrames(project_id, added.map((f) => f.id), requester?.id).catch((e) => {
      console.error('[DesignExplorer] add-more failed:', e);
    });

    return createSuccessResponse(added.map(serializeDesignFrame), 201);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to add variations');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
