/**
 * POST /api/projects/[project_id]/checkpoints/revert  { sha }
 * Forward-restore the project's source to a checkpoint (the state after a past
 * agent turn). Non-destructive to checkpoint history.
 */
import { NextRequest } from 'next/server';
import path from 'path';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canAccessProject } from '@/lib/services/project-access';
import { getProjectById } from '@/lib/services/project';
import { revertToCheckpoint } from '@/lib/services/checkpoints';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR) ? PROJECTS_DIR : path.resolve(process.cwd(), PROJECTS_DIR);

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const project = await getProjectById(project_id);
    if (!project) return createErrorResponse('not_found', 'Project not found', 404);
    if (authEnabled()) {
      const user = await getSessionUser();
      if (!user) return createErrorResponse('unauthorized', 'Authentication required', 401);
      const dbProject = await prisma.project.findUnique({ where: { id: project_id } });
      if (!dbProject || !(await canAccessProject(user, dbProject))) return createErrorResponse('forbidden', 'Access denied', 403);
    }

    const body = (await request.json().catch(() => null)) ?? {};
    const sha = typeof body.sha === 'string' ? body.sha.trim() : '';
    if (!/^[0-9a-f]{7,40}$/iu.test(sha)) return createErrorResponse('invalid', 'A valid checkpoint sha is required', 400);

    const projectPath = project.repoPath
      ? (path.isAbsolute(project.repoPath) ? project.repoPath : path.resolve(process.cwd(), project.repoPath))
      : path.join(PROJECTS_DIR_ABSOLUTE, project_id);

    const result = revertToCheckpoint(project_id, projectPath, sha);
    if (!result.ok) return createErrorResponse('revert_failed', result.error || 'Revert failed', 400);
    return createSuccessResponse({ reverted: true, newSha: result.newSha ?? null });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to revert checkpoint');
  }
}
