import { NextRequest, NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getProjectGitSettings, setProjectGitBranch } from '@/lib/services/github';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/** Per-project git settings: the connected repo + the operating branch. */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id);
    if (_gate) return _gate;
    const settings = await getProjectGitSettings(project_id);
    return NextResponse.json({ success: true, ...settings });
  } catch (error) {
    const status = error instanceof Error && 'status' in error ? (error as any).status ?? 500 : 500;
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Unknown error' },
      { status },
    );
  }
}

/** Update the operating branch (validated against the remote). */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id, { manage: true });
    if (_gate) return _gate;
    const body = (await request.json().catch(() => null)) ?? {};
    if (typeof body.branch !== 'string' || body.branch.trim().length === 0) {
      return NextResponse.json({ success: false, message: 'branch is required' }, { status: 400 });
    }
    const branch = await setProjectGitBranch(project_id, body.branch);
    return NextResponse.json({ success: true, branch });
  } catch (error) {
    console.error('[API] Failed to update git settings:', error);
    const status = error instanceof Error && 'status' in error ? (error as any).status ?? 500 : 500;
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Unknown error' },
      { status },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
