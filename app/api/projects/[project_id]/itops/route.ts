/**
 * Admin-only: toggle the shared it-ops tools for a project's agent.
 *   GET /api/projects/:id/itops -> { enabled }   (403 for non-admins)
 *   PUT /api/projects/:id/itops -> { enabled: boolean }
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface Ctx { params: Promise<{ project_id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);
    const { project_id } = await params;
    const project = await prisma.project.findUnique({ where: { id: project_id }, select: { itopsEnabled: true } });
    if (!project) return createErrorResponse('not_found', 'Project not found', 404);
    return createSuccessResponse({ enabled: project.itopsEnabled });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to read it-ops setting');
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);
    const { project_id } = await params;
    const body = (await req.json().catch(() => null)) ?? {};
    if (typeof body.enabled !== 'boolean') {
      return createErrorResponse('invalid_input', 'enabled must be a boolean', 400);
    }
    await prisma.project.update({ where: { id: project_id }, data: { itopsEnabled: body.enabled } });
    return createSuccessResponse({ enabled: body.enabled });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to update it-ops setting');
  }
}
