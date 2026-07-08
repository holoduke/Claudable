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
import { listSharedMcpForProject } from '@/lib/services/shared-mcp';
import { accountMcpConnectorsEnabled } from '@/lib/services/cli/claude-container';
import { runUsesRequestersOwnAccount } from '@/lib/services/claude-credentials';
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
    // The viewer sees shared servers + their OWN private ones (not others').
    const [project, builtin, catalog, shared] = await Promise.all([
      listProjectMcpServers(project_id, user?.id),
      getBuiltinMcpServers(project_id, !!user?.itopsEnabled),
      getMcpCatalog(),
      listSharedMcpForProject(project_id),
    ]);
    // The catalog lists predefined servers not yet configured for this project.
    const configured = new Set(project.map((s) => s.name));
    const available = catalog.filter((c) => !configured.has(c.name));
    // Account managed connectors (Gmail/Drive/Atlassian/…) are only actually
    // inherited on the CONTAINERIZED agent path with passthrough on — the same
    // set `claude mcp list` shows. Only claim it when both hold, so the in-process
    // dev path doesn't over-promise.
    const containerized = process.env.AGENT_CONTAINERIZED?.trim()
      ? process.env.AGENT_CONTAINERIZED.trim() === 'true'
      : Boolean(process.env.PREVIEW_ISOLATION?.trim());
    // Only claim connectors for THIS viewer if their own runs would actually get
    // them (own account) — a teammate on a shared/global-token project won't.
    const accountConnectors =
      containerized &&
      accountMcpConnectorsEnabled() &&
      (await runUsesRequestersOwnAccount(project_id, user?.id).catch(() => false));
    // Only the enabled shared servers actually attach to this project's agent.
    const sharedActive = shared.filter((s) => s.enabled);
    return createSuccessResponse({ project, builtin, catalog: available, accountConnectors, shared: sharedActive });
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
    // A 'private' server is owned by the adding user (only their runs get it).
    const actor = await getSessionUser();
    const created = await createProjectMcpServer(project_id, body as McpServerInput, actor?.id);
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
