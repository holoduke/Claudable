/**
 * Eén organisatie (superadmin).
 *   PATCH  /api/orgs/:org_id  -> { name?, type?, domain?, canCreateProjects?, allowOwnToken? }
 *   DELETE /api/orgs/:org_id  -> alleen als de org geen projecten/leden heeft
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { updateOrg, deleteOrg } from '@/lib/services/orgs';
import { orgErrorResponse } from '@/lib/services/settings-org-errors';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ org_id: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Superadmin access required', 403);

    const { org_id } = await params;
    const body = (await request.json().catch(() => null)) ?? {};
    const org = await updateOrg(org_id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      type: typeof body.type === 'string' ? body.type : undefined,
      domain: typeof body.domain === 'string' || body.domain === null ? body.domain : undefined,
      canCreateProjects: typeof body.canCreateProjects === 'boolean' ? body.canCreateProjects : undefined,
      allowOwnToken: typeof body.allowOwnToken === 'boolean' ? body.allowOwnToken : undefined,
    }, admin);
    return createSuccessResponse(org);
  } catch (error) {
    const orgError = orgErrorResponse(error);
    if (orgError) return orgError;
    return handleApiError(error, 'API', 'Failed to update organization');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Superadmin access required', 403);

    const { org_id } = await params;
    await deleteOrg(org_id, admin);
    return createSuccessResponse({ deleted: true });
  } catch (error) {
    const orgError = orgErrorResponse(error);
    if (orgError) return orgError;
    return handleApiError(error, 'API', 'Failed to delete organization');
  }
}
