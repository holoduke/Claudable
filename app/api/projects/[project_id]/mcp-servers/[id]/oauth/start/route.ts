/**
 * POST /api/projects/[project_id]/mcp-servers/[id]/oauth/start
 * Begin the MCP OAuth flow — discover + register + PKCE, return the auth URL the
 * client redirects the user's browser to.
 */
import { NextRequest } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { prisma } from '@/lib/db/client';
import { startOAuth } from '@/lib/services/mcp-oauth';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

interface RouteContext { params: Promise<{ project_id: string; id: string }> }

export async function POST(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, id } = await params;
    const gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (gate) return gate;
    const server = await prisma.projectMcpServer.findFirst({ where: { id, projectId: project_id } });
    if (!server) return createErrorResponse('MCP server not found', undefined, 404);
    const { authUrl } = await startOAuth(server);
    return createSuccessResponse({ authUrl });
  } catch (error) {
    if (error instanceof Error && !(error as { status?: number }).status) {
      return createErrorResponse(error.message, undefined, 400);
    }
    return handleApiError(error, 'API', 'Failed to start MCP authentication');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
