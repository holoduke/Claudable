import { describe, expect, it } from 'vitest';
import { mapUsageResponse } from './subscription-usage';

describe('mapUsageResponse', () => {
  it('maps 0..100 utilization to 0..1 fractions with reset times', () => {
    const limits = mapUsageResponse({
      five_hour: { utilization: 7.0, resets_at: '2026-08-19T12:09:59+00:00' },
      seven_day: { utilization: 12.0, resets_at: '2026-08-23T00:59:59+00:00' },
    });
    expect(limits?.fiveHour?.utilization).toBeCloseTo(0.07);
    expect(limits?.fiveHour?.resetsAt).toBe('2026-08-19T12:09:59+00:00');
    expect(limits?.sevenDay?.utilization).toBeCloseTo(0.12);
    expect(limits?.updatedAt).toBeTruthy();
  });

  it('keeps a genuine 0% as a reported value', () => {
    const limits = mapUsageResponse({
      five_hour: { utilization: 0.0, resets_at: '2026-08-19T12:09:59+00:00' },
    });
    expect(limits?.fiveHour?.utilization).toBe(0);
  });

  it('clamps utilization above 100', () => {
    const limits = mapUsageResponse({ five_hour: { utilization: 130, resets_at: null } });
    expect(limits?.fiveHour?.utilization).toBe(1);
  });

  it('drops windows with no usable fields and returns null when nothing maps', () => {
    expect(mapUsageResponse({ five_hour: { utilization: null, resets_at: null } })).toBeNull();
    expect(mapUsageResponse(null)).toBeNull();
    expect(mapUsageResponse('nope')).toBeNull();
  });

  it('tolerates missing windows', () => {
    const limits = mapUsageResponse({ five_hour: { utilization: 55, resets_at: null } });
    expect(limits?.fiveHour?.utilization).toBeCloseTo(0.55);
    expect(limits?.sevenDay).toBeUndefined();
  });
});
