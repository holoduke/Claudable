/**
 * GET /api/orgs/:org_id/audit?limit= — auditspoor van beheeracties in een org.
 * Eigenaar/beheerder van de org (of superadmin).
 */
import { NextRequest } from 'next/server';
import { requireOrgManager } from '@/lib/services/org-access';
import { listOrgAudit } from '@/lib/services/audit';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<{ org_id: string }> }) {
  try {
    const { org_id } = await params;
    const gate = await requireOrgManager(org_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);
    const limit = Number(request.nextUrl.searchParams.get('limit') ?? 100);
    return createSuccessResponse(await listOrgAudit(org_id, Number.isFinite(limit) ? limit : 100));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list audit events');
  }
}
