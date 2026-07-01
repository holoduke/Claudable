/**
 * Preview comments for a project.
 *   GET    ?route=/path   -> comments for that route (all routes if omitted)
 *   POST   { route, anchorSelector, relX, relY, body } -> create (author = session)
 *   DELETE                -> clear ALL comments in the project
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { getProjectById } from '@/lib/services/project';
import { listComments, createComment, clearComments } from '@/lib/services/comments';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

async function requireProject(projectId: string) {
  const project = await getProjectById(projectId);
  return project;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    if (!(await requireProject(project_id))) return createErrorResponse('not_found', 'Project not found', 404);
    const route = request.nextUrl.searchParams.get('route') || undefined;
    return createSuccessResponse(await listComments(project_id, route));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list comments');
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const user = await getSessionUser();
    if (authEnabled() && !user) return createErrorResponse('unauthorized', 'Authentication required', 401);
    if (!(await requireProject(project_id))) return createErrorResponse('not_found', 'Project not found', 404);

    const body = (await request.json().catch(() => null)) ?? {};
    const { route, anchorSelector, relX, relY } = body;
    if (typeof route !== 'string' || typeof anchorSelector !== 'string' ||
        typeof relX !== 'number' || typeof relY !== 'number' ||
        typeof body.body !== 'string' || !body.body.trim()) {
      return createErrorResponse('invalid', 'route, anchorSelector, relX, relY and body are required', 400);
    }

    const authorName = user?.name || (user?.email ? user.email.split('@')[0] : null);
    const created = await createComment({
      projectId: project_id,
      route,
      anchorSelector,
      relX,
      relY,
      body: body.body.trim().slice(0, 4000),
      authorId: user?.id ?? null,
      authorName,
    });
    return createSuccessResponse(created);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to create comment');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    if (authEnabled() && !(await getSessionUser())) return createErrorResponse('unauthorized', 'Authentication required', 401);
    if (!(await requireProject(project_id))) return createErrorResponse('not_found', 'Project not found', 404);
    const removed = await clearComments(project_id);
    return createSuccessResponse({ removed });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to clear comments');
  }
}
