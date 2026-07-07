/**
 * Org-shared MCP servers (admin-managed).
 * GET  /api/shared-mcp-servers  - list the org's shared servers (secrets masked)
 * POST /api/shared-mcp-servers  - add a shared server
 *
 * These auto-attach to every project's agent run in the org. Admin-only; when
 * the auth gate is off (single-tenant) anyone may manage them and they are
 * instance-wide (orgId null).
 */
import { NextRequest } from 'next/server';
import { denyUnlessAdmin } from '@/lib/auth/gate';
import { authEnabled, getSessionUser } from '@/lib/auth/session';
import { listSharedMcpServers, createSharedMcpServer, type SharedMcpInput } from '@/lib/services/shared-mcp';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The org scope for the current admin — null when auth is off (instance-wide). */
async function scopeOrgId(): Promise<string | null> {
  if (!authEnabled()) return null;
  const user = await getSessionUser();
  return user?.orgId ?? null;
}

export async function GET() {
  try {
    const denied = await denyUnlessAdmin();
    if (denied) return denied;
    return createSuccessResponse(await listSharedMcpServers(await scopeOrgId()));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list shared MCP servers');
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await denyUnlessAdmin();
    if (denied) return denied;
    const body = (await request.json().catch(() => ({}))) as Partial<SharedMcpInput>;
    if (!body || typeof body.name !== 'string' || !body.transport) {
      return createErrorResponse('name and transport are required', undefined, 400);
    }
    const created = await createSharedMcpServer(await scopeOrgId(), body as SharedMcpInput);
    return createSuccessResponse(created, 201);
  } catch (error) {
    if (error instanceof Error && !(error as { status?: number }).status) {
      return createErrorResponse(error.message, undefined, 400);
    }
    return handleApiError(error, 'API', 'Failed to add shared MCP server');
  }
}
