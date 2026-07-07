/**
 * Registry of in-flight agent turns so a Stop request can interrupt the running
 * process (CLI parity: Esc/Stop kills the current turn, queued messages then
 * flow). Keyed by projectId — one live turn per project. Stored on globalThis
 * so every Next route bundle (dev HMR duplicates module instances) sees the
 * same map.
 *
 * Lifecycle (three-phase, so Stop is never a no-op and two turns can't race):
 *   1. reserve  — the act route claims the project slot SYNCHRONOUSLY (before any
 *      await can interleave) so a concurrent double-submit is rejected as busy.
 *   2. attach   — the executor swaps in the real abort() once the process exists.
 *      If Stop arrived during startup (between reserve and attach), the pending
 *      abort is applied the instant the process is attached.
 *   3. release  — the executor's finally removes the slot when the turn ends.
 */

interface ActiveAgentRun {
  requestId?: string;
  startedAt: number;
  /** Real process kill; a no-op placeholder until the executor attaches. */
  abort: () => void;
  /** Stop was requested before/while the process existed — attach kills at once. */
  aborted: boolean;
}

const GLOBAL_KEY = '__claudableActiveAgentRuns__';

const store: Map<string, ActiveAgentRun> =
  (globalThis as Record<string, any>)[GLOBAL_KEY] ?? new Map<string, ActiveAgentRun>();
(globalThis as Record<string, any>)[GLOBAL_KEY] = store;

/**
 * Synchronously claim the project's single turn slot. Returns false if a turn is
 * already reserved/running for this project. Because there is no await between the
 * `has` check and the `set`, two near-simultaneous POSTs cannot both succeed —
 * this is the atomic busy gate (the DB check is a cross-restart backstop, not the
 * concurrency guard).
 */
export function tryReserveAgentRun(projectId: string): boolean {
  if (store.has(projectId)) return false;
  store.set(projectId, { startedAt: Date.now(), abort: () => {}, aborted: false });
  return true;
}

/** Tag the reserved slot with the turn's requestId (for Stop/cleanup scoping). */
export function setReservedRequestId(projectId: string, requestId?: string): void {
  const current = store.get(projectId);
  if (!current || !requestId) return;
  store.set(projectId, { ...current, requestId });
}

/**
 * Upgrade the reserved slot with the process's real abort handle. If nothing was
 * reserved (internal caller that skipped the route), create the slot. If Stop was
 * pressed during startup, the process is aborted immediately so the kill isn't
 * lost.
 */
export function attachAgentAbort(
  projectId: string,
  requestId: string | undefined,
  abort: () => void
): void {
  const current = store.get(projectId);
  if (!current) {
    store.set(projectId, { requestId, startedAt: Date.now(), abort, aborted: false });
    return;
  }
  store.set(projectId, { ...current, requestId: requestId ?? current.requestId, abort });
  if (current.aborted) {
    try {
      abort();
    } catch {
      /* process already gone */
    }
  }
}

/** Register a run in one shot (reserve + attach) — for callers not fronted by the
 *  route's reserve step. Kept for backwards compatibility. */
export function registerAgentRun(
  projectId: string,
  run: { requestId?: string; abort: () => void }
): void {
  attachAgentAbort(projectId, run.requestId, run.abort);
}

/** Remove a finished/aborted run. Scoped by requestId so a newer turn that
 *  re-registered under the same project isn't clobbered by the old turn's
 *  cleanup. */
export function releaseAgentRun(projectId: string, requestId?: string): void {
  const current = store.get(projectId);
  if (!current) return;
  if (requestId && current.requestId && current.requestId !== requestId) return;
  store.delete(projectId);
}

/** Back-compat alias. */
export const unregisterAgentRun = releaseAgentRun;

/** Whether an agent turn is currently in-flight for this project (read-only).
 *  Used by auto-sync to skip a project mid-turn (committing/merging under it
 *  would fight the running agent). */
export function isAgentRunActive(projectId: string): boolean {
  return store.has(projectId);
}

/**
 * Abort the project's live turn, if any. Returns what was interrupted.
 *
 * The slot is NOT deleted here: it is marked aborted and left in place so that
 * (a) a Stop that lands during startup still kills the process the moment attach
 * runs, and (b) a fresh turn can't start until the executor's own finally
 * releases the slot. The abort itself is idempotent and best-effort.
 */
export function interruptAgentRun(projectId: string): { interrupted: boolean; requestId?: string } {
  const current = store.get(projectId);
  if (!current) return { interrupted: false };
  store.set(projectId, { ...current, aborted: true });
  try {
    current.abort();
  } catch {
    /* process already gone */
  }
  return { interrupted: true, requestId: current.requestId };
}
