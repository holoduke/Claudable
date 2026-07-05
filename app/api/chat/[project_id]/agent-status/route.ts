import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getAgentUsageSnapshot } from '@/lib/services/agent-usage';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/**
 * Agent usage snapshot for the chat status panel: context occupancy, last-turn
 * tokens/cost, cumulative totals and subscription rate-limit windows. Live
 * updates arrive over the SSE stream as `agent_status` events; this endpoint
 * covers the initial load (and post-restart recovery from the persisted copy).
 */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const denied = await denyUnlessProjectAccess(project_id);
    if (denied) return denied;

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
