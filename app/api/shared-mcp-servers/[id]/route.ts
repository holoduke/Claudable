/**
 * PATCH  /api/shared-mcp-servers/[id]  - toggle/edit a shared server
 * DELETE /api/shared-mcp-servers/[id]  - remove a shared server
 * Admin-only; scoped to the admin's org (null = instance-wide when auth is off).
 */
import { NextRequest } from 'next/server';
import { denyUnlessAdmin } from '@/lib/auth/gate';
import { authEnabled, getSessionUser } from '@/lib/auth/session';
import { updateSharedMcpServer, deleteSharedMcpServer, type SharedMcpInput } from '@/lib/services/shared-mcp';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext { params: Promise<{ id: string }>; }

async function scopeOrgId(): Promise<string | null> {
  if (!authEnabled()) return null;
  const user = await getSessionUser();
  return user?.orgId ?? null;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const denied = await denyUnlessAdmin();
    if (denied) return denied;
    const { id } = await params;
    const patch = (await request.json().catch(() => ({}))) as Partial<SharedMcpInput>;
    const updated = await updateSharedMcpServer(id, await scopeOrgId(), patch);
    if (!updated) return createErrorResponse('not_found', 'Shared MCP server not found', 404);
    return createSuccessResponse(updated);
  } catch (error) {
    if (error instanceof Error && !(error as { status?: number }).status) {
      return createErrorResponse(error.message, undefined, 400);
    }
    return handleApiError(error, 'API', 'Failed to update shared MCP server');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const denied = await denyUnlessAdmin();
    if (denied) return denied;
    const { id } = await params;
    const ok = await deleteSharedMcpServer(id, await scopeOrgId());
    if (!ok) return createErrorResponse('not_found', 'Shared MCP server not found', 404);
    return createSuccessResponse({ deleted: true });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to delete shared MCP server');
  }
}
