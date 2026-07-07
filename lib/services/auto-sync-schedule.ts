/**
 * Pure scheduling helpers for git auto-sync — no DB, network, or heavy imports,
 * so they're cheap to unit-test and safe to import from anywhere (the settings
 * layer and the scheduler both use them).
 */

// Auto-sync (background pull) cadence bounds. The scheduler ticks ~every minute,
// so a sub-minute interval buys nothing; a hard ceiling keeps a fat-fingered
// value from parking a project a month behind.
export const AUTO_SYNC_DEFAULT_MINUTES = 5;
export const AUTO_SYNC_MIN_MINUTES = 1;
export const AUTO_SYNC_MAX_MINUTES = 1440; // 24h

/** Coerce any stored/user value into the allowed [MIN, MAX] minute range. */
export function clampAutoSyncMinutes(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return AUTO_SYNC_DEFAULT_MINUTES;
  return Math.min(AUTO_SYNC_MAX_MINUTES, Math.max(AUTO_SYNC_MIN_MINUTES, n));
}

/** Is a project due for another sync? `lastAttemptMs` is 0 when it hasn't been
 *  synced yet this process (→ due on the first tick, so projects catch up
 *  shortly after a restart). The interval is clamped so a bad stored value
 *  can't disable syncing or busy-loop. */
export function isDueForSync(lastAttemptMs: number, intervalMinutes: number, nowMs: number): boolean {
  const interval = clampAutoSyncMinutes(intervalMinutes) * 60_000;
  return nowMs - lastAttemptMs >= interval;
}
