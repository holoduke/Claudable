import { describe, expect, it } from 'vitest';
import { createClientLogLimiter } from './client-log-rate-limit';

describe('createClientLogLimiter', () => {
  it('allows up to max batches per window, then drops', () => {
    const allow = createClientLogLimiter(3, 1000);
    expect([allow('p', 0), allow('p', 1), allow('p', 2), allow('p', 3)]).toEqual([true, true, true, false]);
  });
  it('resets after the window', () => {
    const allow = createClientLogLimiter(1, 1000);
    expect(allow('p', 0)).toBe(true);
    expect(allow('p', 999)).toBe(false);
    expect(allow('p', 1000)).toBe(true);
  });
  it('keeps projects independent', () => {
    const allow = createClientLogLimiter(1, 1000);
    expect(allow('a', 0)).toBe(true);
    expect(allow('b', 0)).toBe(true);
    expect(allow('a', 1)).toBe(false);
  });
});
