import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
const { parseStatsLines } = await import('./container-stats');
const { normalizeResources } = await import('./managed-containers');

describe('parseStatsLines', () => {
  it('reads docker stats JSON lines and skips junk', () => {
    const out = [
      '{"Name":"claudable-preview-x","CPUPerc":"3.21%","MemUsage":"128.4MiB / 2GiB","MemPerc":"6.27%"}',
      'WARNING: something',
      '{broken',
      '{"Name":"/claudable-svc-x-db","CPUPerc":"0.10%","MemUsage":"40MiB / 512MiB","MemPerc":"7.81%"}',
    ].join('\n');
    expect(parseStatsLines(out)).toEqual({
      'claudable-preview-x': { cpu: '3.21%', mem: '128.4MiB / 2GiB', memPerc: '6.27%' },
      'claudable-svc-x-db': { cpu: '0.10%', mem: '40MiB / 512MiB', memPerc: '7.81%' },
    });
  });
});

describe('normalizeResources', () => {
  it('accepts sane limits and normalizes them', () => {
    expect(normalizeResources('512m', '1')).toEqual({ memory: '512m', cpus: '1' });
    expect(normalizeResources('2G', 0.5)).toEqual({ memory: '2048m', cpus: '0.5' });
    expect(normalizeResources(undefined, undefined)).toEqual({});
  });
  it('refuses limits that could starve the box, and garbage', () => {
    for (const [m, c] of [['200g', '1'], ['64m', '1'], ['512', '1'], ['1g; rm -rf /', '1'], ['512m', '64'], ['512m', '0'], ['512m', 'NaN']]) {
      expect(() => normalizeResources(m, c), `${m} ${c}`).toThrow();
    }
  });
});
