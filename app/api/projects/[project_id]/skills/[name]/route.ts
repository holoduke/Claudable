/**
 * Single skill API
 * GET    /api/projects/[project_id]/skills/[name] - read a skill
 * DELETE /api/projects/[project_id]/skills/[name] - delete a skill
 */

import { NextRequest } from 'next/server';
import { getSkill, deleteSkill, SkillError } from '@/lib/services/skills';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

interface RouteContext {
  params: Promise<{ project_id: string; name: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, name } = await params;
    const skill = await getSkill(project_id, name);
    if (!skill) {
      return createErrorResponse('Skill not found', undefined, 404);
    }
    return createSuccessResponse(skill);
  } catch (error) {
    if (error instanceof SkillError) {
      return createErrorResponse(error.message, undefined, error.status);
    }
    return handleApiError(error, 'API', 'Failed to read skill');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, name } = await params;
    const ok = await deleteSkill(project_id, name);
    return createSuccessResponse({ deleted: ok, name });
  } catch (error) {
    if (error instanceof SkillError) {
      return createErrorResponse(error.message, undefined, error.status);
    }
    return handleApiError(error, 'API', 'Failed to delete skill');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
