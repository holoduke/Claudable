/**
 * GET /api/auth/config — public, non-sensitive auth configuration for the client.
 * Lets the UI tell "auth off (single-tenant → the local operator is the admin)"
 * apart from "auth on but signed out", which /api/users/me alone can't express
 * (both return a null user). Used to decide whether to surface admin-only tabs.
 */
import { authEnabled } from '@/lib/auth/session';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return createSuccessResponse({ authEnabled: authEnabled() });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to read auth config');
  }
}
