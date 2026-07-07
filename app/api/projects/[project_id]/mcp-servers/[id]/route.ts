/**
 * Per-project MCP server item API
 * PATCH  /api/projects/[project_id]/mcp-servers/[id]  - edit / toggle enabled
 * DELETE /api/projects/[project_id]/mcp-servers/[id]  - remove
 */
import { NextRequest } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import {
  updateProjectMcpServer,
  deleteProjectMcpServer,
  type McpServerInput,
} from '@/lib/services/project-mcp';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

interface RouteContext {
  params: Promise<{ project_id: string; id: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, id } = await params;
    const gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (gate) return gate;
    const body = (await request.json().catch(() => ({}))) as Partial<McpServerInput>;
    const updated = await updateProjectMcpServer(project_id, id, body);
    if (!updated) return createErrorResponse('MCP server not found', undefined, 404);
    return createSuccessResponse(updated);
  } catch (error) {
    if (error instanceof Error && !(error as { status?: number }).status) {
      return createErrorResponse(error.message, undefined, 400);
    }
    return handleApiError(error, 'API', 'Failed to update MCP server');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, id } = await params;
    const gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (gate) return gate;
    const ok = await deleteProjectMcpServer(project_id, id);
    if (!ok) return createErrorResponse('MCP server not found', undefined, 404);
    return createSuccessResponse({ deleted: true });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to delete MCP server');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
