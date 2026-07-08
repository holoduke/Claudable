/**
 * PATCH  /api/plugins/marketplaces/[id]  - toggle enabled / includeMcpServers / ref
 * DELETE /api/plugins/marketplaces/[id]  - unregister (removes the on-disk clone)
 * Admin-only; scoped to the admin's org (null = instance-wide when auth is off).
 */
import { NextRequest } from 'next/server';
import { denyUnlessAdmin } from '@/lib/auth/gate';
import { authEnabled, getSessionUser } from '@/lib/auth/session';
import { updateMarketplace, removeMarketplace } from '@/lib/services/plugins';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext { params: Promise<{ id: string }>; }

async function scopeOrgId(): Promise<string | null> {
  if (!authEnabled()) return null;
  const user = await getSessionUser();
  return user?.orgId ?? null;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const denied = await denyUnlessAdmin();
    if (denied) return denied;
    const { id } = await params;
    const patch = (await request.json().catch(() => ({}))) as { enabled?: boolean; includeMcpServers?: boolean; ref?: string | null };
    return createSuccessResponse(await updateMarketplace(await scopeOrgId(), id, patch));
  } catch (error) {
    if (error instanceof Error && !(error as { status?: number }).status) {
      return createErrorResponse(error.message, undefined, 400);
    }
    return handleApiError(error, 'API', 'Failed to update plugin marketplace');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const denied = await denyUnlessAdmin();
    if (denied) return denied;
    const { id } = await params;
    await removeMarketplace(await scopeOrgId(), id);
    return createSuccessResponse({ removed: true });
  } catch (error) {
    if (error instanceof Error && !(error as { status?: number }).status) {
      return createErrorResponse(error.message, undefined, 400);
    }
    return handleApiError(error, 'API', 'Failed to remove plugin marketplace');
  }
}
