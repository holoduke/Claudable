/**
 * Leden van een organisatie. Lezen: elk lid van de org (of superadmin).
 * Muteren: eigenaar/beheerder van de org (of superadmin); een beheerder kan
 * geen eigenaren aanmaken of aanraken (org-access.ts).
 *   GET  /api/orgs/:org_id/members  -> ledenlijst met rollen
 *   POST /api/orgs/:org_id/members  -> { email, role? } lid toevoegen
 *        (bestaande gebruiker krijgt direct een lidmaatschap; een onbekend
 *        e-mailadres krijgt een uitnodiging — antwoord heeft `invited: true`)
 */
import { NextRequest } from 'next/server';
import { requireOrgManager, requireOrgMember } from '@/lib/services/org-access';
import { listOrgMembers, addOrgMember, isOrgPolicyError } from '@/lib/services/orgs';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ org_id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { org_id } = await params;
    const gate = await requireOrgMember(org_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);
    return createSuccessResponse(await listOrgMembers(org_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list members');
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { org_id } = await params;
    const gate = await requireOrgManager(org_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);
    const body = (await request.json().catch(() => null)) ?? {};
    const email = typeof body.email === 'string' ? body.email : '';
    const role = typeof body.role === 'string' && body.role ? body.role : 'lid';
    const member = await addOrgMember(org_id, email, role, { ...gate.actor, user: gate.actor.user });
    return createSuccessResponse(member, 201);
  } catch (error) {
    if (isOrgPolicyError(error)) return createErrorResponse('forbidden', (error as Error).message, 403);
    if (error instanceof Error && /e-mailadres|Rol moet|niet gevonden/u.test(error.message)) {
      return createErrorResponse('invalid_input', error.message, 400);
    }
    return handleApiError(error, 'API', 'Failed to add member');
  }
}
