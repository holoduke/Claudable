import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getAgentUsageSnapshot, mergeApiRateLimits } from '@/lib/services/agent-usage';
import { resolveProjectClaudeToken } from '@/lib/services/claude-credentials';
import { fetchSubscriptionUsage } from '@/lib/services/subscription-usage';
import { getSessionUser } from '@/lib/auth/session';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/**
 * Agent usage snapshot for the chat status panel: context occupancy, last-turn
 * tokens/cost, cumulative totals and subscription rate-limit windows. Live
 * updates arrive over the SSE stream as `agent_status` events; this endpoint
 * covers the initial load (and post-restart recovery from the persisted copy).
 *
 * Window utilization comes from the OAuth usage endpoint (the CLI stream no
 * longer reports percentages), fetched for the same account this requester's
 * runs would use and short-cached in the service. Best-effort: on failure the
 * panel just shows the event-derived state.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const denied = await denyUnlessProjectAccess(project_id);
    if (denied) return denied;

    try {
      const requester = await getSessionUser();
      const token =
        (await resolveProjectClaudeToken(project_id, requester?.id)) ??
        process.env.CLAUDE_CODE_OAUTH_TOKEN ??
        null;
      if (token) {
        const limits = await fetchSubscriptionUsage(token);
        if (limits) mergeApiRateLimits(limits);
      }
    } catch (usageError) {
      console.warn('[API] Subscription usage refresh failed:', usageError);
    }

    const snapshot = await getAgentUsageSnapshot(project_id);
    return NextResponse.json({ success: true, data: snapshot });
  } catch (error) {
    console.error('[API] Failed to get agent status:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to get agent status',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
