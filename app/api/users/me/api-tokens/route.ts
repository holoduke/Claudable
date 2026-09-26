/**
 * Personal API tokens — GET/POST /api/users/me/api-tokens
 * Lets a signed-in user create tokens for scripts and bots that act as them (see lib/auth/api-token.ts).
 * Requires a real session (see lib/auth/api-token-route.ts).
 */
import { tokenManager } from '@/lib/auth/api-token-route';
import { ApiTokenError, createApiToken, listApiTokens } from '@/lib/auth/api-token';
import { recordAudit } from '@/lib/services/audit';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const user = await tokenManager(request, { mutation: false });
    if (!user) return createErrorResponse('unauthorized', 'Sign in to manage API tokens', 401);
    return createSuccessResponse(await listApiTokens(user.id));
  } catch (error) {
    return handleApiError(error, 'API tokens', 'Failed to list API tokens');
  }
}

/** POST { name, expiresInDays? } -> { token, record }. The token is returned only here, once. */
export async function POST(request: Request) {
  try {
    const user = await tokenManager(request, { mutation: true });
    if (!user) return createErrorResponse('unauthorized', 'Sign in to manage API tokens', 401);
    const body = (await request.json().catch(() => null)) ?? {};
    const days = body.expiresInDays == null ? null : Number(body.expiresInDays);
    const created = await createApiToken(user.id, typeof body.name === 'string' ? body.name : '', days);
    await recordAudit({
      orgId: user.orgId, actor: user, action: 'user.api_token.created', targetType: 'api_token', targetId: created.record.id,
      meta: { name: created.record.name, expiresAt: created.record.expiresAt },
    });
    return createSuccessResponse(created, 201);
  } catch (error) {
    if (error instanceof ApiTokenError) return createErrorResponse('invalid', error.message, 400);
    return handleApiError(error, 'API tokens', 'Failed to create API token');
  }
}
