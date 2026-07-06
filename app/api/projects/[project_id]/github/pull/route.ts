import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { pullProjectFromGitHub } from '@/lib/services/github';
import { previewManager } from '@/lib/services/preview';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/**
 * Sync the project with its remote branch (pull). When the pull actually
 * changed files and a preview is running, the preview is restarted so what's
 * served matches the synced code (dev-server HMR doesn't cover compiled
 * backends or dependency changes).
 */
export async function POST(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (_gate) return _gate;

    const result = await pullProjectFromGitHub(project_id);

    let previewRestarted = false;
    if (result.updated) {
      try {
        const status = previewManager.getStatus(project_id);
        if (status.status === 'running') {
          await previewManager.stop(project_id);
          await previewManager.start(project_id);
          previewRestarted = true;
        }
      } catch (e) {
        console.warn('[API] Preview restart after sync failed (sync itself succeeded):', e);
      }
    }

    return NextResponse.json({
      success: true,
      updated: result.updated,
      branch: result.branch,
      message: result.message,
      preview_restarted: previewRestarted,
    });
  } catch (error) {
    console.error('[API] Failed to sync from Git:', error);
    const status = error instanceof Error && 'status' in error ? (error as any).status ?? 500 : 500;
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to sync from Git',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
