/**
 * POST /api/projects/[project_id]/design-explorer/generate
 * Create a canvas + N pending frames and kick off generation (fire-and-forget).
 * Progress arrives over the project SSE as `design_frame` events. Returns the
 * created canvas immediately.
 */
import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getSessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { pickDiverseStyles } from '@/lib/services/design-explorer/styles';
import { generateFrames } from '@/lib/services/design-explorer/generate';
import { serializeDesignCanvas } from '@/lib/serializers/design-explorer';
import { listDesignCatalog } from '@/lib/services/design-skills';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

interface RouteContext { params: Promise<{ project_id: string }>; }

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (_gate) return _gate;

    // Reject oversized bodies BEFORE parsing into memory — the optional
    // referenceImage is a base64 data URL, so cap the whole request generously
    // (8MB image ≈ ~11MB base64 + prompt).
    const declaredLen = Number(request.headers.get('content-length') || 0);
    if (declaredLen && declaredLen > 12 * 1024 * 1024) {
      return createErrorResponse('too_large', 'Request too large (reference image max 8MB)', 413);
    }

    const body = (await request.json().catch(() => null)) ?? {};
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return createErrorResponse('invalid', 'A design brief (prompt) is required', 400);

    const count = Math.min(6, Math.max(1, Number.parseInt(String(body.count ?? 3), 10) || 3));
    const requester = await getSessionUser();

    // Resolve the style seed for each frame: explicit styleIds, else auto-diverse.
    const requestedIds: string[] = Array.isArray(body.styleIds)
      ? body.styleIds.filter((s: unknown): s is string => typeof s === 'string')
      : [];
    const catalog = await listDesignCatalog();
    const byId = new Map(catalog.map((c) => [c.id, c]));
    let seeds =
      requestedIds.length > 0
        ? requestedIds.slice(0, count).map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => Boolean(c))
        : await pickDiverseStyles(count);
    // If explicit styleIds didn't resolve to `count` valid styles, top up with
    // diverse ones so the user still gets the number of variations they asked for.
    if (seeds.length < count) {
      const have = new Set(seeds.map((s) => s.id));
      for (const s of await pickDiverseStyles(count)) {
        if (seeds.length >= count) break;
        if (!have.has(s.id)) { seeds.push(s); have.add(s.id); }
      }
    }

    const canvas = await prisma.designCanvas.create({
      data: {
        projectId: project_id,
        title: prompt.slice(0, 60),
        prompt,
        status: 'generating',
        createdById: requester?.id ?? null,
      },
    });

    // Optional reference image (data URL) — store it once per canvas; frames copy
    // it into their scratch so the agent can match it. Cap the size defensively.
    const ref = typeof body.referenceImage === 'string' ? body.referenceImage : '';
    const m = ref.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/u);
    if (m) {
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 0 && buf.length <= 8 * 1024 * 1024) {
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const dir = path.resolve(process.cwd(), 'data', 'design-canvases', canvas.id);
        await fs.mkdir(dir, { recursive: true });
        const refPath = path.join(dir, `reference.${ext}`);
        await fs.writeFile(refPath, buf);
        await prisma.designCanvas.update({ where: { id: canvas.id }, data: { referenceImagePath: refPath } });
      }
    }

    // One frame per seed (fall back to a single unseeded frame if the catalog is empty).
    const specs = seeds.length > 0 ? seeds : [null];
    await prisma.designFrame.createMany({
      data: specs.map((seed) => ({
        canvasId: canvas.id,
        styleId: seed?.id ?? null,
        styleName: seed?.name ?? null,
        prompt,
        status: 'pending',
      })),
    });
    const frames = await prisma.designFrame.findMany({ where: { canvasId: canvas.id }, orderBy: { createdAt: 'asc' } });

    // Fire-and-forget — the SSE stream carries progress.
    void generateFrames(project_id, frames.map((f) => f.id), requester?.id).catch((e) => {
      console.error('[DesignExplorer] generation failed:', e);
    });

    return createSuccessResponse(serializeDesignCanvas({ ...canvas, frames }), 201);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to start design generation');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
