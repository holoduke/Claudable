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
import { isOrgMember } from '@/lib/services/org-access';
import { recordAudit } from '@/lib/services/audit';
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
    // Default to least-privilege viewer; only 'editor' grants write.
    const role = body.role === 'editor' ? 'editor' : 'viewer';

    // Only assign members of the project's own organisation — never leak
    // across orgs. A project without an org (data error) can't take members.
    if (!gate.project.orgId) {
      return createErrorResponse('invalid_project', 'Project has no organisation', 409);
    }
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true } });
    if (!target || !target.isActive || !(await isOrgMember(userId, gate.project.orgId))) {
      return createErrorResponse('invalid_user', 'User is not in this organization', 400);
    }

    await addProjectMember(project_id, userId, role);
    await recordAudit({ orgId: gate.project.orgId, actor: gate.user, action: 'project.member.added', targetType: 'project', targetId: project_id, meta: { userId, role } });
    return createSuccessResponse(await getProjectAccess(project_id), 201);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to add project member');
  }
}
