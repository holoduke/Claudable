/**
 * Per-user admin operations.
 *   PATCH  /api/users/:id  -> { role?, isActive? } change role / (de)activate
 *   DELETE /api/users/:id  -> remove a user
 * Admin only. An admin cannot demote, deactivate, or delete their own account
 * (prevents locking the last admin out).
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { setUserRole, setUserActive, deleteUser, serializeUser } from '@/lib/services/users';
import { prisma } from '@/lib/db/client';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);

    const { id } = await params;
    const body = (await request.json().catch(() => null)) ?? {};
    const isSelf = id === admin.id;

    if ('role' in body) {
      if (isSelf && body.role !== 'admin') {
        return createErrorResponse('self_change', 'You cannot change your own role', 400);
      }
      const updated = await setUserRole(id, body.role);
      return createSuccessResponse(serializeUser(updated));
    }

    if ('isActive' in body) {
      if (isSelf && !body.isActive) {
        return createErrorResponse('self_change', 'You cannot deactivate your own account', 400);
      }
      const updated = await setUserActive(id, Boolean(body.isActive));
      return createSuccessResponse(serializeUser(updated));
    }

    return createErrorResponse('no_op', 'Nothing to update', 400);
  } catch (error) {
    if (error instanceof Error && /Role must be/u.test(error.message)) {
      return createErrorResponse('invalid_role', error.message, 400);
    }
    return handleApiError(error, 'API', 'Failed to update user');
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);

    const { id } = await params;
    if (id === admin.id) {
      return createErrorResponse('self_change', 'You cannot delete your own account', 400);
    }

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return createErrorResponse('not_found', 'User not found', 404);

    await deleteUser(id);
    return createSuccessResponse({ id });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to delete user');
  }
}
