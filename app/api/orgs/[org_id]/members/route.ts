/**
 * Leden van een organisatie (superadmin).
 *   GET  /api/orgs/:org_id/members  -> ledenlijst met rollen
 *   POST /api/orgs/:org_id/members  -> { email, role? } lid toevoegen
 *        (bestaande gebruiker krijgt een extra lidmaatschap; onbekende e-mail
 *        wordt als slapende externe gebruiker aangemaakt)
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { listOrgMembers, addOrgMember } from '@/lib/services/orgs';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ org_id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Superadmin access required', 403);

    const { org_id } = await params;
    return createSuccessResponse(await listOrgMembers(org_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list members');
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Superadmin access required', 403);

    const { org_id } = await params;
    const body = (await request.json().catch(() => null)) ?? {};
    const email = typeof body.email === 'string' ? body.email : '';
    const role = typeof body.role === 'string' && body.role ? body.role : 'lid';
    const member = await addOrgMember(org_id, email, role);
    return createSuccessResponse(member, 201);
  } catch (error) {
    if (error instanceof Error && /e-mailadres|Rol moet|niet gevonden/u.test(error.message)) {
      return createErrorResponse('invalid_input', error.message, 400);
    }
    return handleApiError(error, 'API', 'Failed to add member');
  }
}
