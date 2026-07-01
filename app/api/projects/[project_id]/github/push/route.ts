import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { pushProjectToGitHub } from '@/lib/services/github';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function POST(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id);
    if (_gate) return _gate;
    const pushed = await pushProjectToGitHub(project_id);
    return NextResponse.json({
      success: true,
      pushed,
      message: pushed ? 'Changes pushed' : 'Already up to date — no changes to deploy',
    });
  } catch (error) {
    console.error('[API] Failed to push to GitHub:', error);
    const status = error instanceof Error && 'status' in error ? (error as any).status ?? 500 : 500;
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to push to GitHub',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
