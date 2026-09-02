/**
 * Uitnodigingen van een organisatie — GET /api/orgs/:org_id/invites
 * Elk lid van de org (of superadmin) mag zien wie er is uitgenodigd.
 * Aanmaken gebeurt via POST /api/orgs/:org_id/members (onbekend e-mailadres).
 */
import { NextRequest } from 'next/server';
import { requireOrgMember } from '@/lib/services/org-access';
import { listOrgInvites } from '@/lib/services/orgs';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ org_id: string }> }) {
  try {
    const { org_id } = await params;
    const gate = await requireOrgMember(org_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);
    return createSuccessResponse(await listOrgInvites(org_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list invitations');
  }
}
