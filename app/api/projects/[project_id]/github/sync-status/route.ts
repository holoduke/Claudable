import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getProjectSyncStatus } from '@/lib/services/git-sync-status';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/**
 * Is the project's working copy behind its remote branch? Read-only check the
 * chat UI polls to offer "Update" (POST ../github/pull) when the repo moved.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const gate = await denyUnlessProjectAccess(project_id);
    if (gate) return gate;

    const status = await getProjectSyncStatus(project_id);
    return NextResponse.json({ success: true, ...status });
  } catch (error) {
    console.error('[API] Failed to check git sync status:', error);
    const status = error instanceof Error && 'status' in error ? (error as any).status ?? 500 : 500;
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to check git sync status',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
