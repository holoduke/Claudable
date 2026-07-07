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
    let previewError: string | null = null;
    // Only touch the preview when it's actually running and the sync changed
    // files. A dependency-manifest change needs a reinstall BEFORE restart,
    // otherwise the dev server boots against stale node_modules and crashes.
    if (result.updated && previewManager.getStatus(project_id).status === 'running') {
      try {
        await previewManager.stop(project_id);
        if (result.dependenciesChanged) {
          await previewManager.installDependencies(project_id);
        }
        await previewManager.start(project_id);
        previewRestarted = true;
      } catch (e) {
        // The sync itself succeeded; report the restart failure so the UI can
        // tell the user their preview is down (not silently claim success).
        previewError = e instanceof Error ? e.message : 'Preview restart failed';
        console.error('[API] Preview restart after sync failed:', e);
      }
    }

    return NextResponse.json({
      success: true,
      updated: result.updated,
      branch: result.branch,
      message: result.message,
      dependencies_changed: result.dependenciesChanged,
      preview_restarted: previewRestarted,
      preview_error: previewError,
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
