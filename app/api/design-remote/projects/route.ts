/**
 * GET /api/design-remote/projects
 * Lists the caller's claude.ai/design projects, so the import modal can offer
 * them for one-click import. Returns { enabled: false } when the admin opt-in
 * (CLAUDE_AI_SESSION_KEY) is not configured — the UI then shows manual upload only.
 */
import { NextResponse } from 'next/server';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { designRemoteEnabled, listRemoteDesignProjects } from '@/lib/services/design-remote';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Any signed-in user may browse the shared team designs; the credential is
    // the server's, not theirs. Still require a session when the gate is on.
    if (authEnabled() && !(await getSessionUser())) {
      return createErrorResponse('unauthorized', 'Authentication required', 401);
    }
    if (!designRemoteEnabled()) {
      return createSuccessResponse({ enabled: false, projects: [] });
    }
    const projects = await listRemoteDesignProjects();
    return createSuccessResponse({ enabled: true, projects });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list Claude Design projects');
  }
}
