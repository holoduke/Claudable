import { describe, it, expect } from 'vitest';
import {
  clampAutoSyncMinutes,
  isDueForSync,
  AUTO_SYNC_DEFAULT_MINUTES,
  AUTO_SYNC_MIN_MINUTES,
  AUTO_SYNC_MAX_MINUTES,
} from './auto-sync-schedule';

describe('clampAutoSyncMinutes', () => {
  it('keeps in-range values (rounded)', () => {
    expect(clampAutoSyncMinutes(5)).toBe(5);
    expect(clampAutoSyncMinutes(7.4)).toBe(7);
    expect(clampAutoSyncMinutes('12')).toBe(12);
  });

  it('clamps below MIN and above MAX', () => {
    expect(clampAutoSyncMinutes(0)).toBe(AUTO_SYNC_MIN_MINUTES);
    expect(clampAutoSyncMinutes(-30)).toBe(AUTO_SYNC_MIN_MINUTES);
    expect(clampAutoSyncMinutes(99999)).toBe(AUTO_SYNC_MAX_MINUTES);
  });

  it('falls back to the default for junk', () => {
    expect(clampAutoSyncMinutes(undefined)).toBe(AUTO_SYNC_DEFAULT_MINUTES);
    expect(clampAutoSyncMinutes('abc')).toBe(AUTO_SYNC_DEFAULT_MINUTES);
    expect(clampAutoSyncMinutes(NaN)).toBe(AUTO_SYNC_DEFAULT_MINUTES);
  });
});

describe('isDueForSync', () => {
  const MIN = 60_000;

  it('is due immediately when never synced this process (lastAttempt=0)', () => {
    // now is a real epoch timestamp, which dwarfs any interval → due on first tick.
    expect(isDueForSync(0, 5, 1_700_000_000_000)).toBe(true);
  });

  it('is not due before the interval elapses', () => {
    const now = 10 * MIN;
    expect(isDueForSync(now - 4 * MIN, 5, now)).toBe(false);
  });

  it('is due once the interval has elapsed (inclusive)', () => {
    const now = 10 * MIN;
    expect(isDueForSync(now - 5 * MIN, 5, now)).toBe(true);
    expect(isDueForSync(now - 6 * MIN, 5, now)).toBe(true);
  });

  it('uses the clamped interval so a bad stored value never disables syncing', () => {
    const now = 100 * MIN;
    // A stored 0 clamps to MIN (1 min): due after just over a minute.
    expect(isDueForSync(now - 2 * MIN, 0, now)).toBe(true);
    // A huge stored value clamps to MAX (24h): not due after 2 minutes.
    expect(isDueForSync(now - 2 * MIN, 999999, now)).toBe(false);
  });
});
