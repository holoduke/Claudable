import { describe, expect, it } from 'vitest';
import { selectEvictable, type EvictionCandidate } from './eviction';

const NOW = new Date('2026-09-15T12:00:00Z').getTime();
const HOUR = 3600_000;
const policy = { now: NOW, idleMs: HOUR, keepWarm: 5 };

/** A preview last used `minutes` ago. */
const seen = (projectId: string, minutes: number, status = 'running'): EvictionCandidate => ({
  projectId,
  lastAccessedAt: new Date(NOW - minutes * 60_000),
  status,
});

describe('selectEvictable', () => {
  it('leaves previews alone while they are within the idle window', () => {
    expect(selectEvictable([seen('a', 10), seen('b', 30)], policy)).toEqual([]);
  });

  it('stops a long-idle preview once warmer ones fill the keep-warm slots', () => {
    const candidates = [
      seen('recent1', 1), seen('recent2', 2), seen('recent3', 3),
      seen('recent4', 4), seen('recent5', 5),
      seen('stale', 240),
    ];
    expect(selectEvictable(candidates, policy)).toEqual(['stale']);
  });

  it('keeps the 5 most recently used warm even when all are long idle', () => {
    // The point of the feature: daily-driver projects skip the cold start.
    const candidates = Array.from({ length: 8 }, (_, i) => seen(`p${i}`, 120 + i));
    // p0..p4 are the most recent → warm; p5..p7 are older → evicted.
    expect(selectEvictable(candidates, policy)).toEqual(['p5', 'p6', 'p7']);
  });

  it('never touches a preview that is still starting', () => {
    const candidates = [seen('booting', 999, 'starting'), seen('old', 999)];
    // 'booting' is excluded entirely, so 'old' takes a warm slot and survives.
    expect(selectEvictable(candidates, { ...policy, keepWarm: 1 })).toEqual([]);
    expect(selectEvictable(candidates, { ...policy, keepWarm: 0 })).toEqual(['old']);
  });

  it('evicts purely on idle time when keep-warm is switched off', () => {
    const candidates = [seen('fresh', 5), seen('stale', 120)];
    expect(selectEvictable(candidates, { ...policy, keepWarm: 0 })).toEqual(['stale']);
  });

  it('treats a negative keep-warm as zero rather than slicing from the end', () => {
    const candidates = [seen('stale', 120)];
    expect(selectEvictable(candidates, { ...policy, keepWarm: -3 })).toEqual(['stale']);
  });
});
