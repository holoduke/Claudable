/**
 * The current user's Claude credentials.
 *   GET  /api/claude-credentials  -> [{ id, label, shareable, ... }]  (no token)
 *   POST /api/claude-credentials  -> { token, label?, shareable? }  add one
 */
import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { listMyCredentials, listOrgCredentials, saveCredential } from '@/lib/services/claude-credentials';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const me = await getSessionUser();
    if (!me) return createErrorResponse('unauthorized', 'Sign in to manage your Claude account', 401);
    // Admins see every Claude account in the org (incl. other admins'); a regular
    // user sees only their own. Tokens are never returned either way.
    const creds =
      me.role === 'admin'
        ? await listOrgCredentials(me.orgId, me.id)
        : await listMyCredentials(me.id);
    return createSuccessResponse(creds);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list Claude credentials');
  }
}

export async function POST(request: NextRequest) {
  try {
    const me = await getSessionUser();
    if (!me) return createErrorResponse('unauthorized', 'Sign in to connect your Claude account', 401);

    const body = (await request.json().catch(() => null)) ?? {};
    if (typeof body.token !== 'string' || !body.token.trim()) {
      return createErrorResponse('invalid_input', 'A Claude token is required', 400);
    }
    const cred = await saveCredential(me.id, {
      token: body.token,
      label: typeof body.label === 'string' ? body.label : undefined,
      shareable: !!body.shareable,
    });
    return createSuccessResponse(cred, 201);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to save Claude credential');
  }
}
