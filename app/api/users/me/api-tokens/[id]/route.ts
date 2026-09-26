/** Revoke a personal API token — DELETE /api/users/me/api-tokens/:id (real session required). */
import { tokenManager } from '@/lib/auth/api-token-route';
import { revokeApiToken } from '@/lib/auth/api-token';
import { recordAudit } from '@/lib/services/audit';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await tokenManager(request, { mutation: true });
    if (!user) return createErrorResponse('unauthorized', 'Sign in to manage API tokens', 401);
    const { id } = await params;
    if (!(await revokeApiToken(user.id, id))) return createErrorResponse('not_found', 'Token not found', 404);
    await recordAudit({ orgId: user.orgId, actor: user, action: 'user.api_token.revoked', targetType: 'api_token', targetId: id });
    return createSuccessResponse({ revoked: true });
  } catch (error) {
    return handleApiError(error, 'API tokens', 'Failed to revoke API token');
  }
}
