/**
 * Manage a project's public review share link.
 *   GET    -> the current share token (or null)
 *   POST   -> create/return a share token
 *   DELETE -> revoke it
 * Manage rights required when the auth gate is on.
 */
import { NextRequest } from 'next/server';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canManageProject } from '@/lib/services/project-access';
import { getOrCreateShare, getShare, revokeShare } from '@/lib/services/shares';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

async function denyIfCannotManage(projectId: string): Promise<Response | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return createErrorResponse('not_found', 'Project not found', 404);
  if (authEnabled()) {
    const user = await getSessionUser();
    if (!user) return createErrorResponse('unauthorized', 'Authentication required', 401);
    if (!canManageProject(user, project)) return createErrorResponse('forbidden', 'Only the project owner or an admin can share', 403);
  }
  return null;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const denied = await denyIfCannotManage(project_id);
    if (denied) return denied;
    return createSuccessResponse(await getShare(project_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to read share');
  }
}

export async function POST(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const denied = await denyIfCannotManage(project_id);
    if (denied) return denied;
    return createSuccessResponse(await getOrCreateShare(project_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to create share');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const denied = await denyIfCannotManage(project_id);
    if (denied) return denied;
    await revokeShare(project_id);
    return createSuccessResponse({ revoked: true });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to revoke share');
  }
}
