import { NextRequest, NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getProjectGitSettings, setProjectGitBranch, setProjectAutoSync } from '@/lib/services/github';

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

/**
 * Update per-project git settings. Each field is optional; supply any of:
 *  - `branch` (validated against the remote)
 *  - `auto_sync` (boolean) — enable/disable background pull
 *  - `auto_sync_interval_minutes` (number) — cadence (clamped server-side)
 */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id, { manage: true });
    if (_gate) return _gate;
    const body = (await request.json().catch(() => null)) ?? {};

    const hasBranch = typeof body.branch === 'string' && body.branch.trim().length > 0;
    const hasAutoSync = typeof body.auto_sync === 'boolean';
    const hasInterval = body.auto_sync_interval_minutes !== undefined;
    if (!hasBranch && !hasAutoSync && !hasInterval) {
      return NextResponse.json(
        { success: false, message: 'Provide branch, auto_sync, or auto_sync_interval_minutes' },
        { status: 400 },
      );
    }

    const out: Record<string, unknown> = { success: true };
    if (hasBranch) {
      out.branch = await setProjectGitBranch(project_id, body.branch);
    }
    if (hasAutoSync || hasInterval) {
      const auto = await setProjectAutoSync(project_id, {
        enabled: hasAutoSync ? body.auto_sync : undefined,
        intervalMinutes: hasInterval ? Number(body.auto_sync_interval_minutes) : undefined,
      });
      out.auto_sync = auto.auto_sync;
      out.auto_sync_interval_minutes = auto.auto_sync_interval_minutes;
    }
    return NextResponse.json(out);
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
