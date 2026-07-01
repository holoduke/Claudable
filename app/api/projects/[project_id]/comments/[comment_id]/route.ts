/**
 * A single preview comment.
 *   PATCH  { body?, resolved? }  -> edit / (un)resolve
 *   DELETE                       -> remove it
 */
import { NextRequest } from 'next/server';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { updateComment, deleteComment } from '@/lib/services/comments';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ project_id: string; comment_id: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, comment_id } = await params;
    if (authEnabled() && !(await getSessionUser())) return createErrorResponse('unauthorized', 'Authentication required', 401);
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
    if (authEnabled() && !(await getSessionUser())) return createErrorResponse('unauthorized', 'Authentication required', 401);
    const ok = await deleteComment(project_id, comment_id);
    if (!ok) return createErrorResponse('not_found', 'Comment not found', 404);
    return createSuccessResponse({ id: comment_id });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to delete comment');
  }
}
