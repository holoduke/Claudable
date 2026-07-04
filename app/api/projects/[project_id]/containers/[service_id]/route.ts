/**
 * Operate a single managed container.
 *   POST /api/projects/[id]/containers/[service_id]  { action: 'start'|'stop'|'restart' }
 *   GET  /api/projects/[id]/containers/[service_id]/... — logs via ?logs=1&tail=200
 * (logs are served from this same route with ?logs=1 to avoid an extra segment.)
 */
import { NextRequest } from 'next/server';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canAccessProject } from '@/lib/services/project-access';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';
import { serviceAction, serviceLogs } from '@/lib/services/managed-containers';

export const runtime = 'nodejs';

interface RouteContext { params: Promise<{ project_id: string; service_id: string }>; }

async function gate(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return { error: createErrorResponse('not_found', 'Project not found', 404) };
  if (authEnabled()) {
    const user = await getSessionUser();
    if (!user) return { error: createErrorResponse('unauthorized', 'Authentication required', 401) };
    if (!(await canAccessProject(user, project))) return { error: createErrorResponse('forbidden', 'Access denied', 403) };
  }
  return { project };
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, service_id } = await params;
    const { error } = await gate(project_id);
    if (error) return error;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const action = body.action;
    if (action !== 'start' && action !== 'stop' && action !== 'restart') {
      return createErrorResponse('bad_request', 'action must be start, stop, or restart', 400);
    }
    const res = await serviceAction(project_id, service_id, action);
    if (!res.ok) return createErrorResponse('action_failed', res.out || 'Action failed', 400);
    return createSuccessResponse({ ok: true });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to run container action');
  }
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, service_id } = await params;
    const { error } = await gate(project_id);
    if (error) return error;
    const tail = Number(new URL(req.url).searchParams.get('tail') || '200');
    const logs = await serviceLogs(project_id, service_id, Number.isFinite(tail) ? tail : 200);
    return createSuccessResponse({ logs });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to read container logs');
  }
}
