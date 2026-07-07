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
  getBuiltinMcpServers,
  type McpServerInput,
} from '@/lib/services/project-mcp';
import { getSessionUser } from '@/lib/auth/session';
import { getMcpCatalog } from '@/lib/config/mcp-catalog';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const gate = await denyUnlessProjectAccess(project_id);
    if (gate) return gate;
    const user = await getSessionUser();
    const [project, builtin, catalog] = await Promise.all([
      listProjectMcpServers(project_id),
      getBuiltinMcpServers(project_id, !!user?.itopsEnabled),
      getMcpCatalog(),
    ]);
    // The catalog lists predefined servers not yet configured for this project.
    const configured = new Set(project.map((s) => s.name));
    const available = catalog.filter((c) => !configured.has(c.name));
    return createSuccessResponse({ project, builtin, catalog: available });
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
