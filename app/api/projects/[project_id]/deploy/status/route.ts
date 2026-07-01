import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getDeployRunStatus } from '@/lib/services/github';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/**
 * Real deployment status for the self-hosted (Gitea Actions) publish flow:
 * the latest CI run's state (queued/running/success/failure), a link to the
 * run log, and the live URL. Polled by the Publish UI.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id);
    if (_gate) return _gate;
    const status = await getDeployRunStatus(project_id);
    const res = NextResponse.json({ success: true, ...status });
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to get deploy status',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
