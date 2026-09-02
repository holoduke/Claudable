/**
 * Users API (admin) — list members and pre-authorize external emails.
 *   GET  /api/users  -> all users (admin only)
 *   POST /api/users  -> { email } invite/add a user to the admin's org (admin only)
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { listUsers, serializeUser } from '@/lib/services/users';
import { addOrgMember } from '@/lib/services/orgs';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);

    const users = await listUsers(admin.orgId);
    return createSuccessResponse(users.map(serializeUser));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list users');
  }
}

export async function POST(request: NextRequest) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);

    const body = (await request.json().catch(() => null)) ?? {};
    const email = typeof body.email === 'string' ? body.email : '';
    const name = typeof body.name === 'string' ? body.name : undefined;

    // Same path as the Orgs tab: an existing user becomes a member of the
    // admin's org right away; an unknown address gets a 14-day invitation
    // (no dormant User row is created any more).
    void name;
    const result = await addOrgMember(admin.orgId, email, 'lid', { superadmin: true, role: null, user: admin });
    return createSuccessResponse(result, 201);
  } catch (error) {
    if (error instanceof Error && /valid email/u.test(error.message)) {
      return createErrorResponse('invalid_email', error.message, 400);
    }
    return handleApiError(error, 'API', 'Failed to add user');
  }
}
