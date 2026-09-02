/**
 * Org-level Claude credential — the token/key this organisation's projects run
 * on when neither the project nor the requester brings their own.
 *   GET    /api/orgs/:org_id/claude-credential  -> { label, kind, since } | null   (any member)
 *   PUT    /api/orgs/:org_id/claude-credential  -> { label?, token }              (superadmin or eigenaar)
 *   DELETE /api/orgs/:org_id/claude-credential                                     (superadmin or eigenaar)
 * Accepts an OAuth token from `claude setup-token` or a Console API key
 * (sk-ant-api…); the runner picks the matching env var for `claude -p`.
 */
import { NextRequest } from 'next/server';
import { requireOrgMember, requireOrgManager } from '@/lib/services/org-access';
import { clearOrgCredential, getOrgCredentialView, setOrgCredential } from '@/lib/services/claude-credentials';
import { recordAudit } from '@/lib/services/audit';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
type Ctx = { params: Promise<{ org_id: string }> };

function canSet(actor: { superadmin: boolean; role: string | null }) {
  return actor.superadmin || actor.role === 'eigenaar';
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { org_id } = await params;
    const gate = await requireOrgMember(org_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);
    return createSuccessResponse(await getOrgCredentialView(org_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to read organisation credential');
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const { org_id } = await params;
    const gate = await requireOrgManager(org_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);
    if (!canSet(gate.actor)) return createErrorResponse('forbidden', 'Only an eigenaar or superadmin can set the organisation credential', 403);
    const body = (await req.json().catch(() => null)) ?? {};
    const token = typeof body.token === 'string' ? body.token : '';
    if (!token.trim()) return createErrorResponse('invalid_input', 'token is required', 400);
    const result = await setOrgCredential(org_id, gate.actor.user.id, typeof body.label === 'string' ? body.label : '', token);
    await recordAudit({ orgId: org_id, actor: gate.actor.user, action: 'org.claude_credential.set', targetType: 'org', targetId: org_id, meta: { label: result.label } });
    return createSuccessResponse(await getOrgCredentialView(org_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to set organisation credential');
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { org_id } = await params;
    const gate = await requireOrgManager(org_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);
    if (!canSet(gate.actor)) return createErrorResponse('forbidden', 'Only an eigenaar or superadmin can remove the organisation credential', 403);
    const removed = await clearOrgCredential(org_id);
    if (removed) await recordAudit({ orgId: org_id, actor: gate.actor.user, action: 'org.claude_credential.removed', targetType: 'org', targetId: org_id });
    return createSuccessResponse({ removed });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to remove organisation credential');
  }
}
