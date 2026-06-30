/**
 * Current user — GET /api/users/me
 * Returns the signed-in user (or null). Used by the UI to decide whether to
 * show the admin "Users" tab. Works whether or not the auth gate is enabled.
 */
import { getSessionUser } from '@/lib/auth/session';
import { serializeUser, setUserItops } from '@/lib/services/users';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const user = await getSessionUser();
    return createSuccessResponse(user ? serializeUser(user) : null);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to resolve current user');
  }
}

/**
 * PATCH /api/users/me  -> { itopsEnabled }
 * Self-service it-ops toggle. Only ADMINS may enable it for themselves; a
 * non-admin cannot grant themselves it-ops (an admin must do it for them).
 */
export async function PATCH(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return createErrorResponse('unauthorized', 'Not signed in', 401);

    const body = (await request.json().catch(() => null)) ?? {};
    if (typeof body.itopsEnabled !== 'boolean') {
      return createErrorResponse('invalid', 'Provide a boolean "itopsEnabled"', 400);
    }
    if (user.role !== 'admin') {
      return createErrorResponse('forbidden', 'Only admins can enable it-ops for themselves', 403);
    }
    const updated = await setUserItops(user.id, body.itopsEnabled);
    return createSuccessResponse(serializeUser(updated));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to update current user');
  }
}
