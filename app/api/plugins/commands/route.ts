/**
 * GET /api/plugins/commands  - the plugin slash commands available org-wide,
 * as {plugin, command, invocation, description}. Powers the START screen so a
 * new project can be kicked off with a plugin command (e.g. filament:new-project).
 * Any signed-in user may read this (they can create projects); results are
 * scoped to instance-wide + the caller's org.
 */
import { denyUnlessSignedIn } from '@/lib/auth/gate';
import { authEnabled, getSessionUser } from '@/lib/auth/session';
import { listOrgPluginCommands } from '@/lib/services/plugins';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const denied = await denyUnlessSignedIn();
    if (denied) return denied;
    const orgId = authEnabled() ? (await getSessionUser())?.orgId ?? null : null;
    return createSuccessResponse(await listOrgPluginCommands(orgId));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to list plugin commands');
  }
}
