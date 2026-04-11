import { NextRequest } from 'next/server';
import { importGitHubRepository } from '@/lib/services/repo-import';
import { serializeProject } from '@/lib/serializers/project';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

function coerceString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const repoUrl = coerceString(body?.repoUrl) ?? coerceString(body?.repo_url);
    if (!repoUrl) {
      return createErrorResponse('repo_url is required', undefined, 400);
    }

    const project = await importGitHubRepository({
      repoUrl,
      branch: coerceString(body?.branch),
      projectId: coerceString(body?.projectId) ?? coerceString(body?.project_id),
      name: coerceString(body?.name),
      description: coerceString(body?.description),
      preferredCli: coerceString(body?.preferredCli) ?? coerceString(body?.preferred_cli),
      selectedModel: coerceString(body?.selectedModel) ?? coerceString(body?.selected_model),
    });

    return createSuccessResponse(serializeProject(project), 201);
  } catch (error) {
    if (error instanceof Error && error.message.includes('GitHub repository URL')) {
      return createErrorResponse(error.message, undefined, 400);
    }
    if (error instanceof Error && error.message.includes('Only github.com')) {
      return createErrorResponse(error.message, undefined, 400);
    }
    if (error instanceof Error && error.message.includes('target already exists')) {
      return createErrorResponse(error.message, undefined, 409);
    }
    return handleApiError(error, 'API', 'Failed to import GitHub repository');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
