/**
 * Users API (admin) — list members and pre-authorize external emails.
 *   GET  /api/users  -> all users (admin only)
 *   POST /api/users  -> { email, name? } add an external user (admin only)
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { listUsers, addExternalUser, serializeUser } from '@/lib/services/users';
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

export async function POST(request: NextRequest) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);

    const body = (await request.json().catch(() => null)) ?? {};
    const email = typeof body.email === 'string' ? body.email : '';
    const name = typeof body.name === 'string' ? body.name : undefined;

    const user = await addExternalUser(email, name);
    return createSuccessResponse(serializeUser(user), 201);
  } catch (error) {
    if (error instanceof Error && /valid email/u.test(error.message)) {
      return createErrorResponse('invalid_email', error.message, 400);
    }
    return handleApiError(error, 'API', 'Failed to add user');
  }
}
