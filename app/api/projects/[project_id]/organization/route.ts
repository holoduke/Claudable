/**
 * Which organisation a project belongs to (superadmin only).
 *   GET /api/projects/:id/organization -> { orgId, options: [{id,name,type}] }
 *   PUT /api/projects/:id/organization -> { orgId }
 *
 * Moving a project changes who can see it: only members of the new org (plus
 * the owner if they are a member there, and superadmins). Per-project
 * assignments of people who are NOT members of the new org are dropped, so
 * nothing from the old org keeps a foothold. Audited as project.org_changed.
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { recordAudit } from '@/lib/services/audit';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
type Ctx = { params: Promise<{ project_id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Superadmin access required', 403);
    const { project_id } = await params;
    const project = await prisma.project.findUnique({ where: { id: project_id }, select: { orgId: true } });
    if (!project) return createErrorResponse('not_found', 'Project not found', 404);
    const options = await prisma.organization.findMany({ select: { id: true, name: true, type: true }, orderBy: { createdAt: 'asc' } });
    return createSuccessResponse({ orgId: project.orgId, options });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to read project organisation');
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Superadmin access required', 403);
    const { project_id } = await params;
    const body = (await req.json().catch(() => null)) ?? {};
    const orgId = typeof body.orgId === 'string' ? body.orgId : '';
    if (!orgId) return createErrorResponse('invalid_input', 'orgId is required', 400);

    const [project, target] = await Promise.all([
      prisma.project.findUnique({ where: { id: project_id }, include: { organization: { select: { id: true, name: true } } } }),
      prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true } }),
    ]);
    if (!project) return createErrorResponse('not_found', 'Project not found', 404);
    if (!target) return createErrorResponse('not_found', 'Organisation not found', 404);
    if (project.orgId === target.id) return createSuccessResponse({ orgId: target.id, moved: false });

    await prisma.$transaction([
      prisma.project.update({ where: { id: project_id }, data: { orgId: target.id } }),
      // Assignments of people who are not members of the new org don't survive the move.
      prisma.projectMember.deleteMany({
        where: { projectId: project_id, user: { orgMemberships: { none: { orgId: target.id } } } },
      }),
    ]);
    await recordAudit({
      orgId: target.id, actor: admin, action: 'project.org_changed', targetType: 'project', targetId: project_id,
      meta: { name: project.name, from: project.organization?.name ?? null, to: target.name },
    });
    return createSuccessResponse({ orgId: target.id, moved: true });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to move project');
  }
}
