/**
 * Which idle previews to stop.
 *
 * Previews are evicted so the preview port pool can't be permanently held by
 * dev servers nobody is watching. But stopping EVERY idle preview means the
 * projects someone works on daily pay a cold start (~15-20s) every time they
 * come back. So the most recently used ones are kept warm regardless of how
 * long they have been idle; everything older still goes.
 *
 * Kept warm costs memory (a dev server is 0.5-1 GB), which is why the count is
 * small and configurable rather than "keep everything".
 */

export interface EvictionCandidate {
  projectId: string;
  /** When the preview was last opened/heartbeated. */
  lastAccessedAt: Date;
  status: string;
}

export interface EvictionPolicy {
  now: number;
  /** Idle time after which a non-warm preview is stopped. */
  idleMs: number;
  /** How many of the most recently used previews never get evicted. */
  keepWarm: number;
}

/**
 * The projects whose previews should be stopped now.
 *
 * A preview that is still starting is never touched (stopping it mid-boot
 * leaves a half-started dev server and a reserved port).
 */
export function selectEvictable(
  candidates: readonly EvictionCandidate[],
  policy: EvictionPolicy,
): string[] {
  const { now, idleMs, keepWarm } = policy;
  const evictable = candidates.filter((c) => c.status !== 'starting');

  // Most recently used first, so the head of the list is what we keep warm.
  const byRecency = [...evictable].sort(
    (a, b) => b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime(),
  );
  const warm = new Set(
    byRecency.slice(0, Math.max(0, keepWarm)).map((c) => c.projectId),
  );

  return byRecency
    .filter((c) => !warm.has(c.projectId) && now - c.lastAccessedAt.getTime() > idleMs)
    .map((c) => c.projectId);
}
