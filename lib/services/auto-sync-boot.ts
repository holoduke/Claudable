/**
 * Side-effect boot module: start the git auto-sync scheduler once when the
 * Node server first loads this module. Imported by the root layout (a nodejs
 * server component) rather than instrumentation.ts — instrumentation is also
 * compiled for the Edge runtime, where the scheduler's node-only dependency
 * chain (preview → child_process/fs/crypto) can't be bundled. The root layout
 * is nodejs-only, so importing it here keeps that chain out of any edge bundle.
 *
 * startAutoSyncScheduler() is idempotent (a globalThis singleton timer), so it's
 * safe that the layout module may be evaluated on multiple server workers.
 */
import { startAutoSyncScheduler } from './auto-sync';

// Guard: never run under the edge runtime (it can't host setInterval + the node
// deps). In practice this module is only reachable from the nodejs layout, but
// the guard makes the intent explicit and fails safe.
if (process.env.NEXT_RUNTIME !== 'edge') {
  startAutoSyncScheduler();
  // Every project is git: give projects without a repository a local one (and
  // link an existing own-server origin). Delayed so it never competes with boot
  // recovery; idempotent, so a second worker evaluating this is harmless.
  const g = globalThis as Record<string, unknown>;
  if (!g.__claudableGitSweep__) {
    g.__claudableGitSweep__ = true;
    setTimeout(() => {
      void import('./git-adopt')
        .then((m) => m.ensureAllProjectsGit())
        .catch((e) => console.warn('[git] every-project-is-git sweep failed:', e));
    }, 120_000).unref?.();
  }
}
