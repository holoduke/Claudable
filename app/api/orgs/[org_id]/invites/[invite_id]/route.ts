/**
 * DELETE /api/orgs/:org_id/invites/:invite_id — uitnodiging intrekken.
 * Eigenaar/beheerder van de org (of superadmin); een beheerder kan geen
 * eigenaar-uitnodiging intrekken (zelfde rolregels als bij leden).
 */
import { NextRequest } from 'next/server';
import { requireOrgManager } from '@/lib/services/org-access';
import { revokeOrgInvite, isOrgPolicyError } from '@/lib/services/orgs';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ org_id: string; invite_id: string }> }) {
  try {
    const { org_id, invite_id } = await params;
    const gate = await requireOrgManager(org_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);
    await revokeOrgInvite(org_id, invite_id, { ...gate.actor, user: gate.actor.user });
    return createSuccessResponse({ revoked: true });
  } catch (error) {
    if (isOrgPolicyError(error)) return createErrorResponse('forbidden', (error as Error).message, 403);
    if (error instanceof Error && /niet gevonden|al geaccepteerd/u.test(error.message)) {
      return createErrorResponse('invalid_input', error.message, 400);
    }
    return handleApiError(error, 'API', 'Failed to revoke invitation');
  }
}
