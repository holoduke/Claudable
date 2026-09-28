import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/services/tenant-policy', () => ({ isCustomerProject: async () => false }));
vi.mock('./stream', () => ({ streamManager: { publish: () => {} } }));
const { rateLimitsFromEvent } = await import('./agent-usage');

// Captured from the CLI on the server (2026-09-28).
const REAL_EVENT = {
  status: 'allowed', resetsAt: 1790560800, rateLimitType: 'five_hour',
  overageStatus: 'rejected', overageResetsAt: 1790812800, overageDisabledReason: 'org_level_disabled_until', isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.03, resetsAt: 1790560800 }, seven_day: { utilization: 0.14, resetsAt: 1790917200 } },
};

describe('rateLimitsFromEvent', () => {
  it('reads both windows from unifiedWindows (the real numbers)', () => {
    const r = rateLimitsFromEvent(REAL_EVENT, {})!;
    expect(r.fiveHour).toMatchObject({ utilization: 0.03, status: 'allowed', resetsAt: new Date(1790560800 * 1000).toISOString() });
    expect(r.sevenDay).toMatchObject({ utilization: 0.14, resetsAt: new Date(1790917200 * 1000).toISOString() });
    expect(r.updatedAt).toBeTruthy();
  });

  it('still understands the older shape (top-level utilization)', () => {
    const r = rateLimitsFromEvent({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.82, resetsAt: 1790917200 }, {})!;
    expect(r.sevenDay).toMatchObject({ utilization: 0.82, status: 'allowed_warning' });
    expect(r.fiveHour).toBeUndefined();
  });

  it('clears a stale rejected once the window is back under its cap', () => {
    const prev = { fiveHour: { utilization: 1, status: 'rejected' } };
    const r = rateLimitsFromEvent({ ...REAL_EVENT, rateLimitType: 'overage', status: undefined }, prev)!;
    expect(r.fiveHour).toMatchObject({ utilization: 0.03, status: 'allowed' });
  });

  it('tolerates percentages, ignores junk and overage-only events', () => {
    expect(rateLimitsFromEvent({ unifiedWindows: { five_hour: { utilization: 45 } } }, {})!.fiveHour!.utilization).toBe(0.45);
    expect(rateLimitsFromEvent({ rateLimitType: 'overage', status: 'rejected' }, {})).toBeNull();
    expect(rateLimitsFromEvent(null, {})).toBeNull();
    expect(rateLimitsFromEvent({ unifiedWindows: { five_hour: { utilization: -1 } } }, {})).toBeNull();
  });
});
