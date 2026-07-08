/**
 * PATCH /api/plugins/marketplaces/[id]/plugins/[plugin]  - enable/disable one
 * plugin ORG-WIDE within a marketplace (body: { enabled }). Admin-only.
 * Per-PROJECT toggles live under /api/projects/[project_id]/plugins.
 */
import { NextRequest } from 'next/server';
import { denyUnlessAdmin } from '@/lib/auth/gate';
import { authEnabled, getSessionUser } from '@/lib/auth/session';
import { setPluginEnabled } from '@/lib/services/plugins';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext { params: Promise<{ id: string; plugin: string }>; }

async function scopeOrgId(): Promise<string | null> {
  if (!authEnabled()) return null;
  const user = await getSessionUser();
  return user?.orgId ?? null;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const denied = await denyUnlessAdmin();
    if (denied) return denied;
    const { id, plugin } = await params;
    const body = (await request.json().catch(() => ({}))) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') return createErrorResponse('enabled (boolean) is required', undefined, 400);
    return createSuccessResponse(await setPluginEnabled(await scopeOrgId(), id, decodeURIComponent(plugin), body.enabled));
  } catch (error) {
    if (error instanceof Error && !(error as { status?: number }).status) {
      return createErrorResponse(error.message, undefined, 400);
    }
    return handleApiError(error, 'API', 'Failed to toggle plugin');
  }
}
