/**
 * Per-project MCP servers API
 * GET  /api/projects/[project_id]/mcp-servers  - list (secrets masked)
 * POST /api/projects/[project_id]/mcp-servers  - add a server
 */
import { NextRequest } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import {
  listProjectMcpServers,
  createProjectMcpServer,
  type McpServerInput,
} from '@/lib/services/project-mcp';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const gate = await denyUnlessProjectAccess(project_id);
    if (gate) return gate;
    return createSuccessResponse(await listProjectMcpServers(project_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list MCP servers');
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (gate) return gate;
    const body = (await request.json().catch(() => ({}))) as Partial<McpServerInput>;
    if (!body || typeof body.name !== 'string' || !body.transport) {
      return createErrorResponse('name and transport are required', undefined, 400);
    }
    const created = await createProjectMcpServer(project_id, body as McpServerInput);
    return createSuccessResponse(created, 201);
  } catch (error) {
    // Validation errors are user-facing 400s.
    if (error instanceof Error && !(error as { status?: number }).status) {
      return createErrorResponse(error.message, undefined, 400);
    }
    return handleApiError(error, 'API', 'Failed to add MCP server');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
