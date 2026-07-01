/**
 * A single preview comment.
 *   PATCH  { body?, resolved? }  -> edit / (un)resolve
 *   DELETE                       -> remove it
 * Scoped by projectId at the service layer; access-gated when the auth gate is on.
 */
import { NextRequest } from 'next/server';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canAccessProject } from '@/lib/services/project-access';
import { updateComment, deleteComment } from '@/lib/services/comments';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ project_id: string; comment_id: string }>;
}

async function denyIfNoAccess(projectId: string): Promise<Response | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return createErrorResponse('not_found', 'Project not found', 404);
  if (authEnabled()) {
    const user = await getSessionUser();
    if (!user) return createErrorResponse('unauthorized', 'Authentication required', 401);
    if (!(await canAccessProject(user, project))) return createErrorResponse('forbidden', 'Access denied', 403);
  }
  return null;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, comment_id } = await params;
    const denied = await denyIfNoAccess(project_id);
    if (denied) return denied;
    const body = (await request.json().catch(() => null)) ?? {};
    if (body.body !== undefined && typeof body.body !== 'string') return createErrorResponse('invalid', 'body must be a string', 400);
    if (body.resolved !== undefined && typeof body.resolved !== 'boolean') return createErrorResponse('invalid', 'resolved must be a boolean', 400);
    const updated = await updateComment(project_id, comment_id, {
      body: typeof body.body === 'string' ? body.body.trim().slice(0, 4000) : undefined,
      resolved: body.resolved,
    });
    if (!updated) return createErrorResponse('not_found', 'Comment not found', 404);
    return createSuccessResponse(updated);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to update comment');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, comment_id } = await params;
    const denied = await denyIfNoAccess(project_id);
    if (denied) return denied;
    const ok = await deleteComment(project_id, comment_id);
    if (!ok) return createErrorResponse('not_found', 'Comment not found', 404);
    return createSuccessResponse({ id: comment_id });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to delete comment');
  }
}
