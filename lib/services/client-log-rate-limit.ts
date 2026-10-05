/**
 * Per-project budget for the unauthenticated client-log endpoint.
 *
 * The log token is baked into the public bridge script, so any visitor of a
 * preview can post batches. A fixed window per project caps how fast anyone can
 * flood a project's diagnostics buffer (and so what its agent reads back).
 */
export const CLIENT_LOG_WINDOW_MS = 60_000;
export const CLIENT_LOG_MAX_BATCHES = 120;
const MAX_TRACKED_PROJECTS = 5_000;

type Window = { start: number; count: number };

export function createClientLogLimiter(
  max = CLIENT_LOG_MAX_BATCHES,
  windowMs = CLIENT_LOG_WINDOW_MS,
) {
  const windows = new Map<string, Window>();
  return function allow(projectId: string, now = Date.now()): boolean {
    const cur = windows.get(projectId);
    if (!cur || now - cur.start >= windowMs) {
      if (!cur && windows.size >= MAX_TRACKED_PROJECTS) windows.clear();
      windows.set(projectId, { start: now, count: 1 });
      return true;
    }
    if (cur.count >= max) return false;
    windows.set(projectId, { start: cur.start, count: cur.count + 1 });
    return true;
  };
}

export const allowClientLogBatch = createClientLogLimiter();
