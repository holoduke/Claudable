/**
 * Eén lidmaatschap — eigenaar/beheerder van de org (of superadmin).
 *   PATCH  /api/orgs/:org_id/members/:user_id  -> { role }
 *   DELETE /api/orgs/:org_id/members/:user_id  -> lidmaatschap verwijderen
 * De laatste eigenaar van een org kan niet gedegradeerd of verwijderd worden.
 */
import { NextRequest } from 'next/server';
import { requireOrgManager } from '@/lib/services/org-access';
import { updateOrgMemberRole, removeOrgMember } from '@/lib/services/orgs';
import { orgErrorResponse } from '@/lib/services/settings-org-errors';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ org_id: string; user_id: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { org_id, user_id } = await params;
    const gate = await requireOrgManager(org_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);
    const body = (await request.json().catch(() => null)) ?? {};
    const role = typeof body.role === 'string' ? body.role : '';
    const member = await updateOrgMemberRole(org_id, user_id, role, { ...gate.actor, user: gate.actor.user });
    return createSuccessResponse(member);
  } catch (error) {
    const orgError = orgErrorResponse(error);
    if (orgError) return orgError;
    return handleApiError(error, 'API', 'Failed to update member');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { org_id, user_id } = await params;
    const gate = await requireOrgManager(org_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);
    await removeOrgMember(org_id, user_id, { ...gate.actor, user: gate.actor.user });
    return createSuccessResponse({ removed: true });
  } catch (error) {
    const orgError = orgErrorResponse(error);
    if (orgError) return orgError;
    return handleApiError(error, 'API', 'Failed to remove member');
  }
}
