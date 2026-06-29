/**
 * Remove a project member (owner/admin only).
 *   DELETE /api/projects/:id/members/:user_id
 */
import { NextRequest } from 'next/server';
import {
  requireProjectManager,
  removeProjectMember,
  getProjectAccess,
} from '@/lib/services/project-access';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface Ctx { params: Promise<{ project_id: string; user_id: string }> }

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { project_id, user_id } = await params;
    const gate = await requireProjectManager(project_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);

    await removeProjectMember(project_id, user_id);
    return createSuccessResponse(await getProjectAccess(project_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to remove project member');
  }
}
