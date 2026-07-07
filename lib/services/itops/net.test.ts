import { describe, expect, it } from 'vitest';
import { assertHostAllowed } from './net';

describe('assertHostAllowed (SSRF guard)', () => {
  it('blocks loopback and private literals', async () => {
    await expect(assertHostAllowed('127.0.0.1')).rejects.toThrow(/internal|loopback/i);
    await expect(assertHostAllowed('169.254.169.254')).rejects.toThrow(); // AWS IMDS
    await expect(assertHostAllowed('10.0.0.5')).rejects.toThrow();
    await expect(assertHostAllowed('::1')).rejects.toThrow();
  });

  it('blocks IPv4-mapped IPv6 that embeds a private/loopback address', async () => {
    await expect(assertHostAllowed('::ffff:127.0.0.1')).rejects.toThrow(/internal|loopback/i);
    await expect(assertHostAllowed('[::ffff:169.254.169.254]')).rejects.toThrow();
    await expect(assertHostAllowed('::10.0.0.1')).rejects.toThrow();
  });
});
