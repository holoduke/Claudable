import { prisma } from '@/lib/db/client';

/**
 * Statuses that represent an in-flight request. A request in any of these
 * states is only valid while the process that owns it is alive.
 */
const ACTIVE_REQUEST_STATUSES = ['pending', 'processing', 'active', 'running'] as const;

/**
 * Reconcile stale in-flight requests left behind by a crashed or restarted
 * process.
 *
 * A request is driven entirely in-process (executeClaude marks it
 * running -> completed/failed in a finally block). If the Node process is
 * killed mid-run — e.g. a container redeploy or OOM — that finally never
 * runs and the row is stuck in an active status forever, which makes
 * `hasActiveRequests` permanently true and locks the UI.
 *
 * Immediately after a fresh boot no request can legitimately be running
 * (the owning process is gone), so any active-status row is a zombie and is
 * marked failed. This self-heals on every restart.
 */
export async function reconcileStaleRequestsOnStartup(): Promise<number> {
  try {
    const result = await prisma.userRequest.updateMany({
      where: { status: { in: [...ACTIVE_REQUEST_STATUSES] } },
      data: {
        status: 'failed',
        errorMessage: 'Interrupted by a server restart',
        completedAt: new Date(),
      },
    });

    if (result.count > 0) {
      console.log(
        `[StartupRecovery] Reconciled ${result.count} stale request(s) left running after restart`,
      );
    }

    return result.count;
  } catch (error) {
    // Never let recovery failures crash startup.
    console.error('[StartupRecovery] Failed to reconcile stale requests:', error);
    return 0;
  }
}
