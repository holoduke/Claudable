/**
 * Current user — GET /api/users/me
 * Returns the signed-in user (or null). Used by the UI to decide whether to
 * show the admin "Users" tab. Works whether or not the auth gate is enabled.
 */
import { getSessionUser } from '@/lib/auth/session';
import { serializeUser } from '@/lib/services/users';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const user = await getSessionUser();
    return createSuccessResponse(user ? serializeUser(user) : null);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to resolve current user');
  }
}
