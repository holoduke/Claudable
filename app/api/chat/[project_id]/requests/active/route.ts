import { isAgentRunActive } from '@/lib/services/cli/run-registry';
import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getActiveRequests } from '@/lib/services/user-requests';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id);
    if (_gate) return _gate;
    const summary = await getActiveRequests(project_id);
    // agentRunning: the same in-memory run slot the publish route refuses on, so
    // the Publish button and the server agree (hasActiveRequests also counts
    // queued/pending rows and can lag behind a finished turn).
    return NextResponse.json({ ...summary, agentRunning: isAgentRunActive(project_id) });
  } catch (error) {
    console.error('[API] Failed to get active requests:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to get active requests',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
