/**
 * Next.js instrumentation hook — runs once when the server process boots.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  // Only run on the Node.js server runtime (not edge / browser bundles).
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { reconcileStaleRequestsOnStartup } = await import(
    '@/lib/services/startup-recovery'
  );
  await reconcileStaleRequestsOnStartup();

  // Background per-project auto-sync (opt-in via git settings). One process-wide
  // timer; a no-op until a project turns it on.
  const { startAutoSyncScheduler } = await import('@/lib/services/auto-sync');
  startAutoSyncScheduler();
}
