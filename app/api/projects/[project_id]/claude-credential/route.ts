/**
 * Which Claude credential a project's agent runs use (owner/admin only).
 *   GET /api/projects/:id/claude-credential -> { credentialId, options: [...] }
 *   PUT /api/projects/:id/claude-credential -> { credentialId: string | null }
 */
import { NextRequest } from 'next/server';
import { requireProjectManager } from '@/lib/services/project-access';
import { listSelectableCredentials, setProjectCredential } from '@/lib/services/claude-credentials';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface Ctx { params: Promise<{ project_id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { project_id } = await params;
    const gate = await requireProjectManager(project_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);

    const options = await listSelectableCredentials({ id: gate.user.id, orgId: gate.user.orgId });
    return createSuccessResponse({ credentialId: gate.project.claudeCredentialId ?? null, options });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to load project Claude credential');
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const { project_id } = await params;
    const gate = await requireProjectManager(project_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);

    const body = (await req.json().catch(() => null)) ?? {};
    const credentialId = body.credentialId === null || typeof body.credentialId === 'string' ? body.credentialId : undefined;
    if (credentialId === undefined) {
      return createErrorResponse('invalid_input', 'credentialId must be an id or null', 400);
    }

    // If a specific credential is chosen, it must be one the manager can select
    // (their own, or a shareable one in the org) — never an arbitrary id.
    if (credentialId) {
      const options = await listSelectableCredentials({ id: gate.user.id, orgId: gate.user.orgId });
      if (!options.some((c) => c.id === credentialId)) {
        return createErrorResponse('forbidden', 'That credential is not available to this project', 403);
      }
    }

    await setProjectCredential(project_id, credentialId);
    return createSuccessResponse({ credentialId });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to set project Claude credential');
  }
}
