/**
 * Eén organisatie (superadmin).
 *   PATCH  /api/orgs/:org_id  -> { name?, type?, domain? }
 *   DELETE /api/orgs/:org_id  -> alleen als de org geen projecten/leden heeft
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { updateOrg, deleteOrg } from '@/lib/services/orgs';
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
    });
    return createSuccessResponse(org);
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === 'P2002') {
      return createErrorResponse('duplicate_domain', 'Er bestaat al een organisatie met dit domein', 409);
    }
    if (error instanceof Error && /verplicht|ongeldig|moet|leeg/u.test(error.message)) {
      return createErrorResponse('invalid_input', error.message, 400);
    }
    return handleApiError(error, 'API', 'Failed to update organization');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Superadmin access required', 403);

    const { org_id } = await params;
    await deleteOrg(org_id);
    return createSuccessResponse({ deleted: true });
  } catch (error) {
    if (error instanceof Error && /Kan niet verwijderen|niet gevonden/u.test(error.message)) {
      return createErrorResponse('conflict', error.message, 409);
    }
    return handleApiError(error, 'API', 'Failed to delete organization');
  }
}
