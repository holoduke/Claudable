/**
 * PUBLIC: resolve a share token to a live preview (no auth — the token is the
 * credential). Starts the preview if needed and returns its URL + project name.
 */
import { NextRequest } from 'next/server';
import { resolveShareToken } from '@/lib/services/shares';
import { getProjectById } from '@/lib/services/project';
import { previewManager } from '@/lib/services/preview';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ token: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { token } = await params;
    const projectId = await resolveShareToken(token);
    if (!projectId) return createErrorResponse('invalid_token', 'This share link is invalid or has been revoked', 404);

    const project = await getProjectById(projectId);
    if (!project) return createErrorResponse('not_found', 'Project not found', 404);

    // Get the reviewer to a running app fast. For per-project subdomains the URL
    // is deterministic, so return it immediately and warm the dev server in the
    // background (a cold start is ~20-30s — never make the reviewer wait on it;
    // the share page retries the iframe until the app reports ready). Only block
    // on start() when the URL isn't knowable without the assigned port.
    let previewUrl = previewManager.deterministicPreviewUrl(projectId);
    if (previewUrl) {
      void previewManager.start(projectId).catch(() => {});
    } else {
      try {
        const info = await previewManager.start(projectId);
        previewUrl = info.url;
      } catch { /* fall back to whatever's persisted */ }
    }

    return createSuccessResponse({
      projectId,
      projectName: project.name,
      previewUrl,
    });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to resolve share link');
  }
}
