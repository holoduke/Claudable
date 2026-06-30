/**
 * One of the current user's Claude credentials (owner only).
 *   PATCH  /api/claude-credentials/:id  -> { shareable }  toggle sharing
 *   DELETE /api/claude-credentials/:id
 */
import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { setShareable, deleteCredential } from '@/lib/services/claude-credentials';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface Ctx { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    const me = await getSessionUser();
    if (!me) return createErrorResponse('unauthorized', 'Sign in required', 401);
    const { id } = await params;
    const body = (await request.json().catch(() => null)) ?? {};
    if (typeof body.shareable !== 'boolean') {
      return createErrorResponse('invalid_input', 'shareable must be a boolean', 400);
    }
    const ok = await setShareable(id, me.id, body.shareable);
    if (!ok) return createErrorResponse('not_found', 'Credential not found', 404);
    return createSuccessResponse({ id, shareable: body.shareable });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to update credential');
  }
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  try {
    const me = await getSessionUser();
    if (!me) return createErrorResponse('unauthorized', 'Sign in required', 401);
    const { id } = await params;
    const ok = await deleteCredential(id, me.id);
    if (!ok) return createErrorResponse('not_found', 'Credential not found', 404);
    return createSuccessResponse({ id });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to delete credential');
  }
}
