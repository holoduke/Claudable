import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the prisma client + crypto so the service logic can be tested in isolation.
const rows: any[] = [];
const project: { orgId: string | null } = { orgId: null };

vi.mock('@/lib/db/client', () => ({
  prisma: {
    sharedMcpServer: {
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        let out = !where ? [...rows] : rows.filter((r) => {
          if (where.enabled !== undefined && r.enabled !== where.enabled) return false;
          if (where.OR) return where.OR.some((c: any) => c.orgId === r.orgId);
          if ('orgId' in where) return r.orgId === where.orgId;
          return true;
        });
        // Mirror SQLite: orderBy orgId asc puts NULL first.
        if (orderBy?.orgId === 'asc') {
          out = [...out].sort((a, b) => (a.orgId ?? '') < (b.orgId ?? '') ? -1 : (a.orgId ?? '') > (b.orgId ?? '') ? 1 : 0);
        }
        return out;
      }),
      findFirst: vi.fn(async ({ where }: any) => rows.find((r) => r.orgId === where.orgId && r.name === where.name) ?? null),
    },
    project: { findUnique: vi.fn(async () => project) },
  },
}));
vi.mock('@/lib/crypto', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}));
vi.mock('@/lib/services/itops/net', () => ({ assertHostAllowed: vi.fn(async () => {}) }));

import { buildSharedMcpConfig, validateSharedMcpInput } from './shared-mcp';

function seed(...entries: any[]) {
  rows.length = 0;
  rows.push(...entries);
}

describe('shared-mcp', () => {
  beforeEach(() => { rows.length = 0; project.orgId = null; });
  afterEach(() => vi.clearAllMocks());

  it('builds http entries with decrypted headers for instance-wide (null org) servers', async () => {
    seed({
      name: 'company-docs', transport: 'http', url: 'https://docs.example.com/mcp',
      headersEncrypted: 'enc:{"Authorization":"Bearer xyz"}', argsJson: null, command: null,
      envEncrypted: null, enabled: true, orgId: null,
    });
    const cfg = await buildSharedMcpConfig('proj-1');
    expect(cfg['company-docs']).toEqual({ type: 'http', url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer xyz' } });
  });

  it('includes both instance-wide and the project org, but not other orgs', async () => {
    project.orgId = 'org-A';
    seed(
      { name: 'global', transport: 'http', url: 'https://g.example.com/mcp', headersEncrypted: null, argsJson: null, command: null, envEncrypted: null, enabled: true, orgId: null },
      { name: 'orga', transport: 'http', url: 'https://a.example.com/mcp', headersEncrypted: null, argsJson: null, command: null, envEncrypted: null, enabled: true, orgId: 'org-A' },
      { name: 'orgb', transport: 'http', url: 'https://b.example.com/mcp', headersEncrypted: null, argsJson: null, command: null, envEncrypted: null, enabled: true, orgId: 'org-B' },
    );
    const cfg = await buildSharedMcpConfig('proj-1');
    expect(Object.keys(cfg).sort()).toEqual(['global', 'orga']);
  });

  it('org-specific server overrides an instance-wide one with the same name (deterministic)', async () => {
    project.orgId = 'org-A';
    seed(
      { name: 'docs', transport: 'http', url: 'https://global.example.com/mcp', headersEncrypted: null, argsJson: null, command: null, envEncrypted: null, enabled: true, orgId: null },
      { name: 'docs', transport: 'http', url: 'https://orga.example.com/mcp', headersEncrypted: null, argsJson: null, command: null, envEncrypted: null, enabled: true, orgId: 'org-A' },
    );
    const cfg = await buildSharedMcpConfig('proj-1');
    expect(cfg.docs).toEqual({ type: 'http', url: 'https://orga.example.com/mcp' });
  });

  it('never emits a reserved-name server', async () => {
    seed({ name: 'images', transport: 'http', url: 'https://x/mcp', headersEncrypted: null, argsJson: null, command: null, envEncrypted: null, enabled: true, orgId: null });
    const cfg = await buildSharedMcpConfig('proj-1');
    expect(cfg.images).toBeUndefined();
  });

  it('builds stdio entries with args + decrypted env', async () => {
    seed({ name: 'local-tool', transport: 'stdio', url: null, command: 'npx', argsJson: '["-y","pkg"]', headersEncrypted: null, envEncrypted: 'enc:{"TOKEN":"t"}', enabled: true, orgId: null });
    const cfg = await buildSharedMcpConfig('proj-1');
    expect(cfg['local-tool']).toEqual({ command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 't' } });
  });

  it('validate rejects reserved names, non-https and duplicates', async () => {
    await expect(validateSharedMcpInput({ name: 'images', transport: 'http', url: 'https://x/mcp' }, new Set())).rejects.toThrow(/reserved/i);
    await expect(validateSharedMcpInput({ name: 'ok', transport: 'http', url: 'http://x/mcp' }, new Set())).rejects.toThrow(/https/i);
    await expect(validateSharedMcpInput({ name: 'dup', transport: 'http', url: 'https://x/mcp' }, new Set(['dup']))).rejects.toThrow(/already exists/i);
  });
});
