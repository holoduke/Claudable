import { describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { waitForPreviewReady } from './process-utils';

describe('waitForPreviewReady', () => {
  it('lets a slow first compile finish instead of aborting and retrying later', async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      setTimeout(() => res.end('ok'), 2_500); // dev server compiling the first page
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const logs: string[] = [];
    const t0 = Date.now();
    try {
      expect(await waitForPreviewReady(`http://127.0.0.1:${port}`, (c) => logs.push(String(c)), 10_000)).toBe(true);
    } finally {
      server.close();
    }
    expect(Date.now() - t0).toBeLessThan(3_500);
    expect(hits).toBe(1);
    expect(logs.join('\n')).toContain('after 1 attempt(s)');
  }, 15_000);

  it('still retries quickly while nothing listens yet', async () => {
    const probe = http.createServer((_q, r) => r.end());
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((r) => probe.close(() => r()));
    const later = http.createServer((_q, r) => r.end('ok'));
    setTimeout(() => later.listen(port, '127.0.0.1'), 1_200);
    const t0 = Date.now();
    try {
      expect(await waitForPreviewReady(`http://127.0.0.1:${port}`, () => {}, 10_000)).toBe(true);
    } finally {
      later.close();
    }
    expect(Date.now() - t0).toBeLessThan(2_200);
  }, 15_000);
});
