/**
 * POST /api/projects/[project_id]/mcp-servers/[id]/oauth/disconnect
 * Clear the stored OAuth tokens for a server (like the CLI's mcp clear-auth).
 */
import { NextRequest } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { disconnectOAuth } from '@/lib/services/mcp-oauth';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

interface RouteContext { params: Promise<{ project_id: string; id: string }> }

export async function POST(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, id } = await params;
    const gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (gate) return gate;
    const ok = await disconnectOAuth(project_id, id);
    if (!ok) return createErrorResponse('MCP server not found', undefined, 404);
    return createSuccessResponse({ disconnected: true });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to disconnect MCP authentication');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
