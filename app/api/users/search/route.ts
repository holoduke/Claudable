/**
 * Org-scoped user search — GET /api/users/search?q=&project=
 * Powers the project-access assignment and @-mention autocompletes. Available
 * to any signed-in user (project owners need it, not just admins). With
 * `project`, results are the members of THAT project's organisation (the caller
 * must be able to access the project); without it, the caller's home org.
 */
import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canAccessProject, searchOrgUsers } from '@/lib/services/project-access';
import { isOrgMember } from '@/lib/services/org-access';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const me = await getSessionUser();
    if (!me) return createErrorResponse('unauthorized', 'Sign in required', 401);

    const q = request.nextUrl.searchParams.get('q') ?? '';
    const projectId = request.nextUrl.searchParams.get('project');
    if (projectId) {
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project || !(await canAccessProject(me, project))) {
        return createErrorResponse('not_found', 'Project not found', 404);
      }
      if (!project.orgId) return createSuccessResponse([]);
      return createSuccessResponse(await searchOrgUsers(project.orgId, q));
    }
    // No project context: only the caller's home org, and only while they are
    // actually a member of it (User.orgId alone is not an access scope).
    if (!(await isOrgMember(me.id, me.orgId))) return createSuccessResponse([]);
    return createSuccessResponse(await searchOrgUsers(me.orgId, q));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to search users');
  }
}
