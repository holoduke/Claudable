/**
 * Per-project Skills API
 * GET  /api/projects/[project_id]/skills        - list skills
 * POST /api/projects/[project_id]/skills        - create/update a skill
 */

import { NextRequest } from 'next/server';
import { listAllSkills, saveSkill, SkillError } from '@/lib/services/skills';
import { designSkillIds } from '@/lib/services/design-skills';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const skills = await listAllSkills(project_id);
    // Design skills are managed in the separate "Design" tab — keep them out of
    // the general skills list so the two never mix.
    const designIds = await designSkillIds();
    const filtered = {
      project: skills.project.filter((s) => !designIds.has(s.id)),
      global: skills.global.filter((s) => !designIds.has(s.id)),
    };
    return createSuccessResponse(filtered);
  } catch (error) {
    if (error instanceof SkillError) {
      return createErrorResponse(error.message, undefined, error.status);
    }
    return handleApiError(error, 'API', 'Failed to list skills');
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const body = await request.json().catch(() => ({}));
    if (!body || typeof body.name !== 'string' || body.name.trim().length === 0) {
      return createErrorResponse('name is required', undefined, 400);
    }
    const skill = await saveSkill(project_id, {
      name: body.name,
      description: typeof body.description === 'string' ? body.description : '',
      content: typeof body.content === 'string' ? body.content : '',
      raw: typeof body.raw === 'string' ? body.raw : undefined,
    });
    return createSuccessResponse(skill, 201);
  } catch (error) {
    if (error instanceof SkillError) {
      return createErrorResponse(error.message, undefined, error.status);
    }
    return handleApiError(error, 'API', 'Failed to save skill');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
