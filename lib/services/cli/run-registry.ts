/**
 * Registry of in-flight agent turns so a Stop request can interrupt the running
 * process (CLI parity: Esc/Stop kills the current turn, queued messages then
 * flow). Keyed by projectId — one live turn per project. Stored on globalThis
 * so every Next route bundle (dev HMR duplicates module instances) sees the
 * same map.
 */

interface ActiveAgentRun {
  requestId?: string;
  startedAt: number;
  abort: () => void;
}

const GLOBAL_KEY = '__claudableActiveAgentRuns__';

const store: Map<string, ActiveAgentRun> =
  (globalThis as Record<string, any>)[GLOBAL_KEY] ?? new Map<string, ActiveAgentRun>();
(globalThis as Record<string, any>)[GLOBAL_KEY] = store;

export function registerAgentRun(
  projectId: string,
  run: { requestId?: string; abort: () => void }
): void {
  store.set(projectId, { ...run, startedAt: Date.now() });
}

/** Remove a finished run. Scoped by requestId so a newer turn that re-registered
 *  under the same project isn't clobbered by the old turn's cleanup. */
export function unregisterAgentRun(projectId: string, requestId?: string): void {
  const current = store.get(projectId);
  if (!current) return;
  if (requestId && current.requestId && current.requestId !== requestId) return;
  store.delete(projectId);
}

/** Whether an agent turn is currently in-flight for this project (read-only).
 *  Used by auto-sync to skip a project mid-turn (committing/merging under it
 *  would fight the running agent). */
export function isAgentRunActive(projectId: string): boolean {
  return store.has(projectId);
}

/** Abort the project's live turn, if any. Returns what was interrupted. */
export function interruptAgentRun(projectId: string): { interrupted: boolean; requestId?: string } {
  const current = store.get(projectId);
  if (!current) return { interrupted: false };
  store.delete(projectId);
  try {
    current.abort();
  } catch {
    /* process already gone */
  }
  return { interrupted: true, requestId: current.requestId };
}
