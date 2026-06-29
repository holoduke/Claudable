/**
 * Project members (owner/admin only).
 *   POST /api/projects/:id/members  -> { userId }  assign a user
 */
import { NextRequest } from 'next/server';
import {
  requireProjectManager,
  addProjectMember,
  getProjectAccess,
} from '@/lib/services/project-access';
import { prisma } from '@/lib/db/client';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface Ctx { params: Promise<{ project_id: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { project_id } = await params;
    const gate = await requireProjectManager(project_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);

    const body = (await req.json().catch(() => null)) ?? {};
    const userId = typeof body.userId === 'string' ? body.userId : '';
    if (!userId) return createErrorResponse('invalid_input', 'userId is required', 400);

    // Only assign users from the same org as the project (or the manager's org
    // for legacy projects with no orgId) — never leak across orgs.
    const target = await prisma.user.findUnique({ where: { id: userId } });
    const allowedOrg = gate.project.orgId ?? gate.user.orgId;
    if (!target || target.orgId !== allowedOrg) {
      return createErrorResponse('invalid_user', 'User is not in this organization', 400);
    }

    await addProjectMember(project_id, userId);
    return createSuccessResponse(await getProjectAccess(project_id), 201);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to add project member');
  }
}
