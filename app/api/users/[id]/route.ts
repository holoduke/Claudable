/**
 * Per-user admin operations.
 *   PATCH  /api/users/:id  -> { role?, isActive? } change role / (de)activate
 *   DELETE /api/users/:id  -> remove a user
 * Admin only. An admin cannot demote, deactivate, or delete their own account
 * (prevents locking the last admin out).
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { deleteUser, serializeUser } from '@/lib/services/users';
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

    // Scope to the admin's org so a UUID from another org can't be modified.
    const target = await prisma.user.findFirst({ where: { id, orgId: admin.orgId } });
    if (!target) return createErrorResponse('not_found', 'User not found', 404);

    if (hasItops && body.itopsEnabled && !target.isActive) {
      return createErrorResponse('invalid_input', 'Cannot enable it-ops on an inactive account', 400);
    }

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

    // One atomic update so a mid-sequence failure can't leave a half-applied,
    // inconsistent authorization state (e.g. role changed but isActive not).
    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(hasRole ? { role: body.role } : {}),
        ...(hasActive ? { isActive: body.isActive } : {}),
        ...(hasItops ? { itopsEnabled: body.itopsEnabled } : {}),
      },
    });
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

    // Scope to the admin's org so a UUID from another org can't be deleted.
    const target = await prisma.user.findFirst({ where: { id, orgId: admin.orgId } });
    if (!target) return createErrorResponse('not_found', 'User not found', 404);

    // Same last-admin guard as PATCH: never delete the org's only active admin.
    if (target.role === 'admin' && target.isActive) {
      const activeAdmins = await prisma.user.count({
        where: { role: 'admin', isActive: true, orgId: target.orgId },
      });
      if (activeAdmins <= 1) {
        return createErrorResponse('last_admin', 'Cannot delete the last active admin', 409);
      }
    }

    await deleteUser(id);
    return createSuccessResponse({ id });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to delete user');
  }
}
