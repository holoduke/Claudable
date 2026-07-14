/**
 * Auto-sync: keep a project's working copy in step with its Gitea/GitHub branch
 * without the user pressing "Sync" every time. Opt-in per project (a setting in
 * the git connection's service_data: `auto_sync` + `auto_sync_interval_minutes`).
 *
 * Two entry points share ONE orchestration (syncAndRestartPreview):
 *  - the manual POST /github/pull route, and
 *  - the background scheduler below (a single process-wide interval).
 *
 * The scheduler is deliberately conservative: it skips any project with an agent
 * turn in flight (committing/merging under a running agent would fight it), never
 * lets one project's failure stop the loop, and only restarts a preview that was
 * already running. The pull itself commits local edits first and aborts cleanly
 * on a merge conflict (see pullProjectFromGitHub), so auto-sync can't lose work.
 */
import { pullProjectFromGitHub } from './github';
import { clampAutoSyncMinutes, isDueForSync } from './auto-sync-schedule';
import { listServiceConnectionsByProvider } from './project-services';
import { isAgentRunActive } from './cli/run-registry';
import { getActiveRequests } from './user-requests';
import { previewManager } from './preview';

export interface SyncAndRestartResult {
  updated: boolean;
  branch: string;
  message: string;
  dependenciesChanged: boolean;
  previewRestarted: boolean;
  previewError: string | null;
}

/**
 * Pull the project from its remote branch and, when the pull actually changed
 * files and a preview is running, restart the preview so what's served matches
 * the synced code (HMR doesn't cover compiled backends or dependency changes).
 * Shared by the manual sync route and the scheduler.
 */
export async function syncAndRestartPreview(projectId: string): Promise<SyncAndRestartResult> {
  const result = await pullProjectFromGitHub(projectId);

  let previewRestarted = false;
  let previewError: string | null = null;
  // Re-check immediately before stopping: a turn may have started (and
  // auto-started/adopted the preview) between the caller's shouldSkip() and here.
  // Killing the preview mid-turn is disruptive — bail if an agent run is active.
  if (result.updated && previewManager.getStatus(projectId).status === 'running' && !isAgentRunActive(projectId)) {
    try {
      await previewManager.stop(projectId);
      // A dependency-manifest change needs a reinstall BEFORE restart, else the
      // dev server boots against stale node_modules and crashes.
      if (result.dependenciesChanged) {
        await previewManager.installDependencies(projectId);
      }
      await previewManager.start(projectId);
      previewRestarted = true;
    } catch (e) {
      // The sync itself succeeded; surface the restart failure rather than
      // silently claiming success.
      previewError = e instanceof Error ? e.message : 'Preview restart failed';
      console.error('[AutoSync] Preview restart after sync failed:', e);
    }
  }

  return {
    updated: result.updated,
    branch: result.branch,
    message: result.message,
    dependenciesChanged: result.dependenciesChanged,
    previewRestarted,
    previewError,
  };
}

// --- Scheduler ------------------------------------------------------------

/** How often the scheduler wakes to check which projects are due (ms). Per-project
 *  cadence is enforced on top of this, so this only bounds timing granularity. */
const TICK_MS = 60_000;

interface SchedulerState {
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  lastAttempt: Map<string, number>;
}

// On globalThis so Next's dev HMR (which re-evaluates modules) can't spin up a
// second interval, and the same map/flag are shared across route bundles.
const GLOBAL_KEY = '__claudableAutoSyncScheduler__';
const state: SchedulerState =
  (globalThis as Record<string, any>)[GLOBAL_KEY] ??
  { timer: null, ticking: false, lastAttempt: new Map<string, number>() };
(globalThis as Record<string, any>)[GLOBAL_KEY] = state;

/** Should auto-sync skip this project right now? True while an agent turn or any
 *  active request is in flight, or the preview is mid-start (don't stomp it). */
async function shouldSkip(projectId: string): Promise<boolean> {
  if (isAgentRunActive(projectId)) return true;
  if (previewManager.getStatus(projectId).status === 'starting') return true;
  try {
    if ((await getActiveRequests(projectId)).hasActiveRequests) return true;
  } catch {
    // If we can't tell, err on the safe side and skip this tick.
    return true;
  }
  return false;
}

async function tick(): Promise<void> {
  if (state.ticking) return; // a slow tick must not overlap the next
  state.ticking = true;
  try {
    const connections = await listServiceConnectionsByProvider('github');
    const now = Date.now();
    for (const conn of connections) {
      const data = (conn.serviceData ?? {}) as Record<string, any>;
      if (data.auto_sync !== true) continue;
      const projectId = conn.projectId;
      const interval = clampAutoSyncMinutes(data.auto_sync_interval_minutes);
      if (!isDueForSync(state.lastAttempt.get(projectId) ?? 0, interval, now)) continue;
      if (await shouldSkip(projectId)) continue;

      // Stamp the attempt BEFORE running so a hang/failure doesn't retry every
      // tick — the next attempt waits a full interval regardless of outcome.
      state.lastAttempt.set(projectId, Date.now());
      try {
        const r = await syncAndRestartPreview(projectId);
        if (r.updated) {
          console.log(`[AutoSync] ${projectId}: synced ${r.branch}${r.previewRestarted ? ' (preview restarted)' : ''}`);
        }
      } catch (e) {
        // Not-connected projects, transient fetch failures, conflicts — log and
        // move on; never break the loop for the other projects.
        console.warn(`[AutoSync] ${projectId}: sync failed —`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.error('[AutoSync] scheduler tick failed:', e);
  } finally {
    state.ticking = false;
  }
}

/** Start the process-wide auto-sync interval (idempotent). Called once at boot
 *  from instrumentation.ts. A single timer serves every project. */
export function startAutoSyncScheduler(): void {
  if (state.timer) return; // already running
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  // Don't keep the event loop alive on its own — a graceful shutdown shouldn't
  // wait on the sync timer.
  timer.unref?.();
  state.timer = timer;
  console.log('[AutoSync] scheduler started');
}
