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
  // NOTE: the git auto-sync scheduler is NOT started here. instrumentation.ts is
  // compiled for the Edge runtime too (middleware.ts forces an edge bundle), and
  // the scheduler's node-only chain (preview → child_process/fs/crypto) can't be
  // bundled for edge. It's started from the root layout instead (nodejs-only).
}
