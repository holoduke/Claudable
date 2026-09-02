/**
 * Users API (admin) — list members and pre-authorize external emails.
 *   GET  /api/users  -> every account on this installation (superadmin only)
 */
import { getAdminUser } from '@/lib/auth/session';
import { listUsers, serializeUser } from '@/lib/services/users';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);

    const users = await listUsers();
    return createSuccessResponse(users.map(serializeUser));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list users');
  }
}
