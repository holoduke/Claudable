import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getDeployRunLog } from '@/lib/services/deploy-log';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/**
 * The cleaned build/deploy log of the project's latest CI run (errors + tail),
 * so the Publish panel can show why a deploy failed without a Gitea account.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id);
    if (_gate) return _gate;
    const log = await getDeployRunLog(project_id);
    const res = NextResponse.json({ success: true, ...log });
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (error) {
    console.error('[API] Failed to read deploy log:', error);
    return NextResponse.json({ success: false, error: 'Failed to read deploy log' }, { status: 500 });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
