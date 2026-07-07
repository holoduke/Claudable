import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rows: any[] = [];

vi.mock('@/lib/db/client', () => ({
  prisma: {
    projectMcpServer: {
      findMany: vi.fn(async ({ where }: any) => {
        return rows.filter((r) => {
          if (where.projectId && r.projectId !== where.projectId) return false;
          if (where.enabled !== undefined && r.enabled !== where.enabled) return false;
          if (where.OR) return where.OR.some((c: any) => ('ownerId' in c ? r.ownerId === c.ownerId : true));
          return true;
        });
      }),
    },
  },
}));
vi.mock('@/lib/crypto', () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, '') }));
vi.mock('@/lib/services/itops/net', () => ({ assertHostAllowed: vi.fn(async () => {}) }));
vi.mock('@/lib/services/mcp-oauth', () => ({ authStatusOf: () => 'none', getValidAccessToken: async () => null }));

import { buildProjectMcpConfig, listProjectMcpServers } from './project-mcp';

function http(name: string, ownerId: string | null, enabled = true) {
  return { id: name, projectId: 'p1', ownerId, name, label: name, transport: 'http', url: `https://${name}.example.com/mcp`, argsJson: null, command: null, headersEncrypted: null, envEncrypted: null, enabled, authType: null, createdAt: new Date(), updatedAt: new Date() };
}

describe('project-mcp visibility', () => {
  beforeEach(() => { rows.length = 0; });
  afterEach(() => vi.clearAllMocks());

  it('build attaches shared + the acting user\'s own private, never another user\'s', async () => {
    rows.push(http('shared', null), http('alice-priv', 'alice'), http('bob-priv', 'bob'));
    const forAlice = await buildProjectMcpConfig('p1', 'alice');
    expect(Object.keys(forAlice).sort()).toEqual(['alice-priv', 'shared']);
    const forBob = await buildProjectMcpConfig('p1', 'bob');
    expect(Object.keys(forBob).sort()).toEqual(['bob-priv', 'shared']);
  });

  it('build with no acting user (auth off) attaches only shared', async () => {
    rows.push(http('shared', null), http('alice-priv', 'alice'));
    const cfg = await buildProjectMcpConfig('p1');
    expect(Object.keys(cfg)).toEqual(['shared']);
  });

  it('list returns shared + own private, marks visibility', async () => {
    rows.push(http('shared', null), http('alice-priv', 'alice'), http('bob-priv', 'bob'));
    const view = await listProjectMcpServers('p1', 'alice');
    expect(view.map((v) => `${v.name}:${v.visibility}`).sort()).toEqual(['alice-priv:private', 'shared:shared']);
  });
});
