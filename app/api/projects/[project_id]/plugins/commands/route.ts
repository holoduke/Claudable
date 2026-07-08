/**
 * GET /api/projects/[project_id]/plugins/commands  - the slash commands the
 * enabled plugins contribute to this project, as {plugin, command, invocation,
 * description}. Powers the chat "/" autocomplete so /<plugin>:<command> is
 * discoverable, exactly like the CLI.
 */
import { NextRequest } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { listProjectPluginCommands } from '@/lib/services/plugins';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext { params: Promise<{ project_id: string }>; }

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const gate = await denyUnlessProjectAccess(project_id);
    if (gate) return gate;
    return createSuccessResponse(await listProjectPluginCommands(project_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list project plugin commands');
  }
}
