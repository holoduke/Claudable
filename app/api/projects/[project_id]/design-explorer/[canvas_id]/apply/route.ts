/**
 * POST /api/projects/[project_id]/design-explorer/[canvas_id]/apply { frameId }
 * Stage the chosen frame into the project's design-reference/ and return an
 * editable port prompt. Does NOT run the agent — the client feeds the prompt to
 * the normal act pipeline (like DesignImportModal), so it gets a checkpoint.
 */
import { NextRequest } from 'next/server';
import path from 'path';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getProjectById } from '@/lib/services/project';
import { prisma } from '@/lib/db/client';
import { stageFrameForPort } from '@/lib/services/design-explorer/apply';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';

interface RouteContext { params: Promise<{ project_id: string; canvas_id: string }>; }

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, canvas_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (_gate) return _gate;

    const body = (await request.json().catch(() => null)) ?? {};
    const frameId = typeof body.frameId === 'string' ? body.frameId : '';
    if (!frameId) return createErrorResponse('invalid', 'frameId is required', 400);

    // Scope the canvas to THIS project (IDOR guard) before trusting frameId — a
    // caller with write access to project A must not stage a frame from a canvas
    // belonging to another project B they can only read.
    const canvas = await prisma.designCanvas.findFirst({ where: { id: canvas_id, projectId: project_id } });
    if (!canvas) return createErrorResponse('not_found', 'Canvas not found', 404);

    const frame = await prisma.designFrame.findUnique({ where: { id: frameId } });
    if (!frame || frame.canvasId !== canvas.id) return createErrorResponse('not_found', 'Frame not found', 404);
    if (frame.status !== 'ready') return createErrorResponse('invalid', 'That design is not ready yet', 400);

    const project = await getProjectById(project_id);
    if (!project) return createErrorResponse('not_found', 'Project not found', 404);
    const projectPath = project.repoPath
      ? (path.isAbsolute(project.repoPath) ? project.repoPath : path.resolve(process.cwd(), project.repoPath))
      : path.resolve(process.cwd(), PROJECTS_DIR, project_id);

    const { suggestedPrompt } = await stageFrameForPort(projectPath, frameId);
    return createSuccessResponse({ suggestedPrompt });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to apply design');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
