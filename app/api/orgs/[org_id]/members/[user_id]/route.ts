/**
 * Eén lidmaatschap (superadmin).
 *   PATCH  /api/orgs/:org_id/members/:user_id  -> { role }
 *   DELETE /api/orgs/:org_id/members/:user_id  -> lidmaatschap verwijderen
 * De laatste eigenaar van een org kan niet gedegradeerd of verwijderd worden.
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { updateOrgMemberRole, removeOrgMember } from '@/lib/services/orgs';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ org_id: string; user_id: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Superadmin access required', 403);

    const { org_id, user_id } = await params;
    const body = (await request.json().catch(() => null)) ?? {};
    const role = typeof body.role === 'string' ? body.role : '';
    const member = await updateOrgMemberRole(org_id, user_id, role);
    return createSuccessResponse(member);
  } catch (error) {
    if (error instanceof Error && /Rol moet|laatste eigenaar/u.test(error.message)) {
      return createErrorResponse('invalid_input', error.message, 400);
    }
    return handleApiError(error, 'API', 'Failed to update member');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Superadmin access required', 403);

    const { org_id, user_id } = await params;
    await removeOrgMember(org_id, user_id);
    return createSuccessResponse({ removed: true });
  } catch (error) {
    if (error instanceof Error && /laatste eigenaar/u.test(error.message)) {
      return createErrorResponse('invalid_input', error.message, 400);
    }
    return handleApiError(error, 'API', 'Failed to remove member');
  }
}
