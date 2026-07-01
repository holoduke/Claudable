/**
 * Per-project Postgres (provisioned via Coolify).
 *   GET    -> current database status (no secrets)
 *   POST   -> provision a Postgres for this project
 *   DELETE -> tear it down
 * Mutations require project-manage rights when the auth gate is on.
 */
import { NextRequest } from 'next/server';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canManageProject } from '@/lib/services/project-access';
import { getProjectById } from '@/lib/services/project';
import { getDatabaseInfo, provisionPostgres, removeDatabase } from '@/lib/services/database';
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
    if (!canManageProject(user, project)) return createErrorResponse('forbidden', 'Only the project owner or an admin can manage the database', 403);
  }
  return null;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    if (!(await getProjectById(project_id))) return createErrorResponse('not_found', 'Project not found', 404);
    return createSuccessResponse(await getDatabaseInfo(project_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to read database status');
  }
}

export async function POST(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const denied = await denyIfCannotManage(project_id);
    if (denied) return denied;
    const info = await provisionPostgres(project_id);
    return createSuccessResponse(info);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to provision database';
    return createErrorResponse('provision_failed', message, 400);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const denied = await denyIfCannotManage(project_id);
    if (denied) return denied;
    await removeDatabase(project_id);
    return createSuccessResponse({ removed: true });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to remove database');
  }
}
