/**
 * Plugin marketplaces (admin-managed, org-wide).
 * GET  /api/plugins/marketplaces  - list marketplaces + their catalogs
 * POST /api/plugins/marketplaces  - register a marketplace (then sync to load it)
 *
 * A registered marketplace's enabled plugins auto-load into every project's
 * agent turn in the org. Admin-only; when the auth gate is off (single-tenant)
 * anyone may manage them and they are instance-wide (orgId null).
 */
import { NextRequest } from 'next/server';
import { denyUnlessAdmin } from '@/lib/auth/gate';
import { authEnabled, getSessionUser } from '@/lib/auth/session';
import { listMarketplaces, addMarketplace, type AddMarketplaceInput } from '@/lib/services/plugins';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function scopeOrgId(): Promise<string | null> {
  if (!authEnabled()) return null;
  const user = await getSessionUser();
  return user?.orgId ?? null;
}

export async function GET() {
  try {
    const denied = await denyUnlessAdmin();
    if (denied) return denied;
    return createSuccessResponse(await listMarketplaces(await scopeOrgId()));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list plugin marketplaces');
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await denyUnlessAdmin();
    if (denied) return denied;
    const body = (await request.json().catch(() => ({}))) as Partial<AddMarketplaceInput>;
    if (!body || typeof body.name !== 'string' || typeof body.gitUrl !== 'string') {
      return createErrorResponse('name and gitUrl are required', undefined, 400);
    }
    const created = await addMarketplace(await scopeOrgId(), body as AddMarketplaceInput);
    return createSuccessResponse(created, 201);
  } catch (error) {
    if (error instanceof Error && !(error as { status?: number }).status) {
      return createErrorResponse(error.message, undefined, 400);
    }
    return handleApiError(error, 'API', 'Failed to add plugin marketplace');
  }
}
