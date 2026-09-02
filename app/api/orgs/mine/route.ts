/**
 * GET /api/orgs/mine — the caller's organisations with their role in each.
 * Any signed-in user. Feeds the org selector on the new-project screen and the
 * "Organisatie" settings tab (which only eigenaar/beheerder get to manage).
 */
import { getSessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { isSuperadmin } from '@/lib/services/org-access';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const me = await getSessionUser();
    if (!me) return createErrorResponse('unauthorized', 'Sign in required', 401);
    const rows = await prisma.orgMember.findMany({
      where: { userId: me.id },
      include: { organization: { include: { _count: { select: { members: true, projects: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    return createSuccessResponse({
      superadmin: isSuperadmin(me),
      homeOrgId: me.orgId,
      orgs: rows.map((r) => ({
        id: r.organization.id,
        name: r.organization.name,
        type: r.organization.type,
        domain: r.organization.domain,
        role: r.role,
        canCreateProjects: r.organization.canCreateProjects,
        hasClaudeCredential: !!r.organization.claudeCredentialId,
        memberCount: r.organization._count.members,
        projectCount: r.organization._count.projects,
      })),
    });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list your organisations');
  }
}
