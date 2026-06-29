/**
 * Project access settings (owner/admin only).
 *   GET /api/projects/:id/access  -> { visibility, members }
 *   PUT /api/projects/:id/access  -> { visibility: 'org' | 'restricted' }
 */
import { NextRequest } from 'next/server';
import {
  requireProjectManager,
  getProjectAccess,
  setProjectVisibility,
} from '@/lib/services/project-access';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface Ctx { params: Promise<{ project_id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { project_id } = await params;
    const gate = await requireProjectManager(project_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);

    return createSuccessResponse(await getProjectAccess(project_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to load project access');
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const { project_id } = await params;
    const gate = await requireProjectManager(project_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);

    const body = (await req.json().catch(() => null)) ?? {};
    if (body.visibility !== 'org' && body.visibility !== 'restricted') {
      return createErrorResponse('invalid_input', 'visibility must be "org" or "restricted"', 400);
    }

    await setProjectVisibility(project_id, body.visibility);
    return createSuccessResponse(await getProjectAccess(project_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to update project access');
  }
}
