/**
 * GET /api/projects/:project_id/credits
 * The credits meter for the chat: the project's organisation budget status when
 * the project belongs to a customer organisation (which runs on its own metered
 * API key), else { enabled: false }.
 */
import { NextRequest } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { isInternalUser, projectTenant } from '@/lib/services/tenant-policy';
import { getSessionUser } from '@/lib/auth/session';
import { getBudgetStatus } from '@/lib/services/org-budget';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ project_id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { project_id } = await params;
    const denied = await denyUnlessProjectAccess(project_id);
    if (denied) return denied;
    const tenant = await projectTenant(project_id);
    if (!tenant.isCustomer || !tenant.orgId) return createSuccessResponse({ enabled: false });
    // Staff runs are booked outside the customer's budget: tell them so.
    const viewerIsStaff = await isInternalUser(await getSessionUser());
    return createSuccessResponse({ enabled: true, viewerIsStaff, ...(await getBudgetStatus(tenant.orgId)) });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to read credits');
  }
}
