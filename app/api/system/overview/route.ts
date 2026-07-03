/**
 * GET /api/system/overview — global container + network overview (admin only).
 */
import { getAdminUser, authEnabled } from '@/lib/auth/session';
import { getSystemOverview } from '@/lib/services/system-overview';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET() {
  try {
    // System-wide infra is admin-only. When the gate is off (local/dev) it's open.
    if (authEnabled() && !(await getAdminUser())) {
      return createErrorResponse('forbidden', 'Admin access required', 403);
    }
    return createSuccessResponse(await getSystemOverview());
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to load system overview');
  }
}
