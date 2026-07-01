/**
 * Read the current runtime diagnostics for a project — recent browser console
 * errors/warnings + Nuxt backend errors. Powers the "Fix with AI" surface and is
 * handy for debugging. Access-gated when the auth gate is on.
 *   GET ?onlyErrors=1&limit=60
 *   DELETE -> clear the buffer
 */
import { NextRequest } from 'next/server';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canAccessProject } from '@/lib/services/project-access';
import { getDiagnostics, clearDiagnostics } from '@/lib/services/diagnostics';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

async function gate(projectId: string): Promise<Response | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return createErrorResponse('not_found', 'Project not found', 404);
  if (authEnabled()) {
    const user = await getSessionUser();
    if (!user) return createErrorResponse('unauthorized', 'Authentication required', 401);
    if (!(await canAccessProject(user, project))) return createErrorResponse('forbidden', 'Access denied', 403);
  }
  return null;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const denied = await gate(project_id);
    if (denied) return denied;
    const onlyErrors = request.nextUrl.searchParams.get('onlyErrors') === '1';
    const limitRaw = Number(request.nextUrl.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    return createSuccessResponse(getDiagnostics(project_id, { onlyErrors, limit }));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to read diagnostics');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const denied = await gate(project_id);
    if (denied) return denied;
    clearDiagnostics(project_id);
    return createSuccessResponse({ cleared: true });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to clear diagnostics');
  }
}
