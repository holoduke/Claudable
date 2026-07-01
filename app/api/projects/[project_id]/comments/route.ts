/**
 * Preview comments for a project.
 *   GET    ?route=/path   -> comments for that route (all routes if omitted)
 *   POST   { route, anchorSelector, relX, relY, body } -> create (author = session)
 *   DELETE                -> clear ALL comments in the project (manager only)
 *
 * When the auth gate is on, reads require project access and the project-wide
 * clear requires manage rights; a project id from another org can't be touched.
 */
import { NextRequest } from 'next/server';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canAccessProject, canManageProject } from '@/lib/services/project-access';
import { shareTokenGrants } from '@/lib/services/shares';
import { listComments, createComment, clearComments } from '@/lib/services/comments';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';
import type { User } from '@prisma/client';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

type Gate = { project: NonNullable<Awaited<ReturnType<typeof loadProject>>>; user: User | null; guest: boolean } | { error: Response };

function loadProject(projectId: string) {
  return prisma.project.findUnique({ where: { id: projectId } });
}

/** Existence + access. A valid share token grants GUEST read+comment (never manage). */
async function gate(projectId: string, manage = false, shareToken?: string | null): Promise<Gate> {
  const project = await loadProject(projectId);
  if (!project) return { error: createErrorResponse('not_found', 'Project not found', 404) };
  const user = await getSessionUser();
  if (!manage && (await shareTokenGrants(projectId, shareToken))) {
    return { project, user: null, guest: true };
  }
  if (authEnabled()) {
    if (!user) return { error: createErrorResponse('unauthorized', 'Authentication required', 401) };
    const allowed = manage ? canManageProject(user, project) : await canAccessProject(user, project);
    if (!allowed) return { error: createErrorResponse('forbidden', 'Access denied', 403) };
  }
  return { project, user, guest: false };
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    // Share token travels in a header, not the query string, so it isn't captured
    // in access logs / browser history / the Referer header.
    const g = await gate(project_id, false, request.headers.get('x-share-token'));
    if ('error' in g) return g.error;
    const route = request.nextUrl.searchParams.get('route') || undefined;
    return createSuccessResponse(await listComments(project_id, route));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list comments');
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const body = (await request.json().catch(() => null)) ?? {};
    const g = await gate(project_id, false, typeof body.shareToken === 'string' ? body.shareToken : null);
    if ('error' in g) return g.error;

    const { route, anchorSelector, relX, relY } = body;
    const bounded = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    if (
      typeof route !== 'string' || route.length === 0 || route.length > 512 ||
      typeof anchorSelector !== 'string' || anchorSelector.length === 0 || anchorSelector.length > 2048 ||
      !bounded(relX) || !bounded(relY) ||
      typeof body.body !== 'string' || !body.body.trim()
    ) {
      return createErrorResponse('invalid', 'Invalid comment payload', 400);
    }

    const authorName =
      g.user?.name || (g.user?.email ? g.user.email.split('@')[0] : null) ||
      (g.guest && typeof body.authorName === 'string' && body.authorName.trim() ? body.authorName.trim().slice(0, 60) : null);
    const created = await createComment({
      projectId: project_id,
      route,
      anchorSelector,
      relX,
      relY,
      body: body.body.trim().slice(0, 4000),
      authorId: g.user?.id ?? null,
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
    const g = await gate(project_id, true); // project-wide wipe → manage rights
    if ('error' in g) return g.error;
    const removed = await clearComments(project_id);
    return createSuccessResponse({ removed });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to clear comments');
  }
}
