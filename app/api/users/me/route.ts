/**
 * Current user — GET /api/users/me
 * Returns the signed-in user (or null). Used by the UI to decide whether to
 * show the admin "Users" tab. Works whether or not the auth gate is enabled.
 */
import { getSessionUser } from '@/lib/auth/session';
import { serializeUser, setUserItops, setUserLocale } from '@/lib/services/users';
import { isLocale } from '@/lib/i18n/config';
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
 * PATCH /api/users/me  -> { itopsEnabled? , locale? }
 * Self-service preferences. Any signed-in user may set their own `locale`
 * (preferred UI language). `itopsEnabled` stays admin-only (a non-admin cannot
 * grant themselves it-ops — an admin must do it for them).
 */
export async function PATCH(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return createErrorResponse('unauthorized', 'Not signed in', 401);

    const body = (await request.json().catch(() => null)) ?? {};

    // Language preference — any signed-in user. `null` clears it (follow default).
    if ('locale' in body) {
      const loc = body.locale;
      if (loc !== null && !isLocale(loc)) {
        return createErrorResponse('invalid', 'Unknown locale', 400);
      }
      const updated = await setUserLocale(user.id, loc);
      return createSuccessResponse(serializeUser(updated));
    }

    // it-ops toggle — admins only.
    if (typeof body.itopsEnabled === 'boolean') {
      if (user.role !== 'admin') {
        return createErrorResponse('forbidden', 'Only admins can enable it-ops for themselves', 403);
      }
      const updated = await setUserItops(user.id, body.itopsEnabled);
      return createSuccessResponse(serializeUser(updated));
    }

    return createErrorResponse('invalid', 'Provide "locale" or a boolean "itopsEnabled"', 400);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to update current user');
  }
}
