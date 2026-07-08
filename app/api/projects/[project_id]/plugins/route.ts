/**
 * GET   /api/projects/[project_id]/plugins  - plugins effective for this project
 *   (instance-wide + its org), each with its effective on/off + synced state.
 * PATCH /api/projects/[project_id]/plugins  - per-project opt-out/opt-in
 *   body: { marketplace, plugin, enabled }. Overrides the org default for this
 *   project only (mirrors the skills per-project toggle).
 */
import { NextRequest } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { listEffectivePlugins, setProjectPluginEnabled } from '@/lib/services/plugins';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext { params: Promise<{ project_id: string }>; }

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const gate = await denyUnlessProjectAccess(project_id);
    if (gate) return gate;
    return createSuccessResponse(await listEffectivePlugins(project_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list project plugins');
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (gate) return gate;
    const body = (await request.json().catch(() => ({}))) as { marketplace?: string; plugin?: string; enabled?: boolean };
    if (typeof body.marketplace !== 'string' || typeof body.plugin !== 'string' || typeof body.enabled !== 'boolean') {
      return createErrorResponse('marketplace, plugin and enabled are required', undefined, 400);
    }
    await setProjectPluginEnabled(project_id, body.marketplace, body.plugin, body.enabled);
    return createSuccessResponse(await listEffectivePlugins(project_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to toggle project plugin');
  }
}
