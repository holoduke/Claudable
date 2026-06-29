/**
 * Per-project active design.
 *   GET /api/projects/:id/design  -> { activeId: string | null }
 *   PUT /api/projects/:id/design  -> { id: string | null }  set/clear the design
 */
import { NextRequest } from 'next/server';
import { getActiveDesign, setActiveDesign } from '@/lib/services/design-skills';
import { SkillError } from '@/lib/services/skills';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface Ctx { params: Promise<{ project_id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { project_id } = await params;
    return createSuccessResponse({ activeId: await getActiveDesign(project_id) });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to load active design');
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const { project_id } = await params;
    const body = (await req.json().catch(() => null)) ?? {};
    const id = body.id === null || typeof body.id === 'string' ? body.id : undefined;
    if (id === undefined) {
      return createErrorResponse('invalid_input', 'id must be a design id or null', 400);
    }
    const activeId = await setActiveDesign(project_id, id);
    return createSuccessResponse({ activeId });
  } catch (error) {
    if (error instanceof SkillError) {
      return createErrorResponse('invalid_design', error.message, error.status);
    }
    return handleApiError(error, 'API', 'Failed to set design');
  }
}
