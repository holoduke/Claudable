/**
 * Org-scoped user search — GET /api/users/search?q=
 * Powers the project-access assignment autocomplete. Available to any signed-in
 * user (project owners need it, not just admins); results are limited to the
 * caller's own organization.
 */
import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { searchOrgUsers } from '@/lib/services/project-access';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const me = await getSessionUser();
    if (!me) return createErrorResponse('unauthorized', 'Sign in required', 401);

    const q = request.nextUrl.searchParams.get('q') ?? '';
    return createSuccessResponse(await searchOrgUsers(me.orgId, q));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to search users');
  }
}
