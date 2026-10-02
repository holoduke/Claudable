/**
 * The current user's Claude credentials.
 *   GET  /api/claude-credentials  -> data: [{ id, label, shareable, ... }] (no token),
 *                                    plus top-level mayUseOwnToken: boolean
 *   POST /api/claude-credentials  -> { token, label?, shareable? }  add one
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { mayUseOwnToken } from '@/lib/services/tenant-policy';
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
    // `data` stays the credential array (existing clients); `mayUseOwnToken`
    // tells the UI whether connecting an own account is allowed at all, so a
    // customer whose org forbids it isn't nudged into a POST that gets a 403.
    return NextResponse.json({ success: true, data: creds, mayUseOwnToken: await mayUseOwnToken(me) });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list Claude credentials');
  }
}

export async function POST(request: NextRequest) {
  try {
    const me = await getSessionUser();
    if (!me) return createErrorResponse('unauthorized', 'Sign in to connect your Claude account', 401);
    if (!(await mayUseOwnToken(me))) {
      return createErrorResponse('forbidden', 'Your organisation does not allow connecting your own Claude account', 403);
    }

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
