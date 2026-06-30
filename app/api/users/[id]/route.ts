/**
 * Per-user admin operations.
 *   PATCH  /api/users/:id  -> { role?, isActive? } change role / (de)activate
 *   DELETE /api/users/:id  -> remove a user
 * Admin only. An admin cannot demote, deactivate, or delete their own account
 * (prevents locking the last admin out).
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { setUserRole, setUserActive, setUserItops, deleteUser, serializeUser } from '@/lib/services/users';
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
    const hasRole = 'role' in body;
    const hasActive = 'isActive' in body;
    const hasItops = 'itopsEnabled' in body;

    if (!hasRole && !hasActive && !hasItops) {
      return createErrorResponse('no_op', 'Provide "role", "isActive" and/or "itopsEnabled"', 400);
    }

    // Validate every field up front so a malformed value can never half-apply.
    if (hasRole && body.role !== 'admin' && body.role !== 'user') {
      return createErrorResponse('invalid_role', 'Role must be "admin" or "user"', 400);
    }
    if (hasActive && typeof body.isActive !== 'boolean') {
      return createErrorResponse('invalid_input', 'isActive must be a boolean', 400);
    }
    if (hasItops && typeof body.itopsEnabled !== 'boolean') {
      return createErrorResponse('invalid_input', 'itopsEnabled must be a boolean', 400);
    }
    if (isSelf && hasRole && body.role !== 'admin') {
      return createErrorResponse('self_change', 'You cannot change your own role', 400);
    }
    if (isSelf && hasActive && body.isActive === false) {
      return createErrorResponse('self_change', 'You cannot deactivate your own account', 400);
    }

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return createErrorResponse('not_found', 'User not found', 404);

    // Never let the org drop to zero active admins (e.g. demoting/deactivating
    // the other admin while you yourself later lose account access).
    const demotingAdmin =
      target.role === 'admin' &&
      ((hasRole && body.role !== 'admin') || (hasActive && body.isActive === false));
    if (demotingAdmin) {
      const activeAdmins = await prisma.user.count({
        where: { role: 'admin', isActive: true, orgId: target.orgId },
      });
      if (activeAdmins <= 1) {
        return createErrorResponse('last_admin', 'Cannot remove the last active admin', 409);
      }
    }

    let updated = target;
    if (hasRole) updated = await setUserRole(id, body.role);
    if (hasActive) updated = await setUserActive(id, body.isActive);
    if (hasItops) updated = await setUserItops(id, body.itopsEnabled);
    return createSuccessResponse(serializeUser(updated));
  } catch (error) {
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
