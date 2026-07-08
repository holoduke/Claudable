/**
 * POST /api/plugins/marketplaces/[id]/sync  - clone/refresh the marketplace repo
 * and re-parse its catalog. Admin-only. Returns the updated view (incl. any
 * lastSyncError so the UI can surface a failed clone).
 */
import { NextRequest } from 'next/server';
import { denyUnlessAdmin } from '@/lib/auth/gate';
import { authEnabled, getSessionUser } from '@/lib/auth/session';
import { syncMarketplace } from '@/lib/services/plugins';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext { params: Promise<{ id: string }>; }

async function scopeOrgId(): Promise<string | null> {
  if (!authEnabled()) return null;
  const user = await getSessionUser();
  return user?.orgId ?? null;
}

export async function POST(_request: NextRequest, { params }: RouteContext) {
  try {
    const denied = await denyUnlessAdmin();
    if (denied) return denied;
    const { id } = await params;
    return createSuccessResponse(await syncMarketplace(await scopeOrgId(), id));
  } catch (error) {
    if (error instanceof Error && !(error as { status?: number }).status) {
      return createErrorResponse(error.message, undefined, 400);
    }
    return handleApiError(error, 'API', 'Failed to sync plugin marketplace');
  }
}
