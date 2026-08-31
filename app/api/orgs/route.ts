/**
 * Organisaties API (superadmin) — de tenant-laag voor het klantportaal.
 *   GET  /api/orgs  -> alle organisaties met leden-/projecttellingen
 *   POST /api/orgs  -> { name, type?, domain? } nieuwe organisatie
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { listOrgs, createOrg } from '@/lib/services/orgs';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Superadmin access required', 403);
    return createSuccessResponse(await listOrgs());
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list organizations');
  }
}

export async function POST(request: NextRequest) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Superadmin access required', 403);

    const body = (await request.json().catch(() => null)) ?? {};
    const org = await createOrg({
      name: typeof body.name === 'string' ? body.name : '',
      type: typeof body.type === 'string' ? body.type : undefined,
      domain: typeof body.domain === 'string' ? body.domain : undefined,
    });
    return createSuccessResponse(org, 201);
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === 'P2002') {
      return createErrorResponse('duplicate_domain', 'Er bestaat al een organisatie met dit domein', 409);
    }
    if (error instanceof Error && /verplicht|ongeldig|moet/u.test(error.message)) {
      return createErrorResponse('invalid_input', error.message, 400);
    }
    return handleApiError(error, 'API', 'Failed to create organization');
  }
}
