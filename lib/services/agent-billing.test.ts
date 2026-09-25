import { beforeEach, describe, expect, it, vi } from 'vitest';

// Credits ledger + run gating for customer orgs, with Prisma, FX and crypto mocked.
type Ev = { orgId: string; sessionId: string | null; costUsd: number; costEurCents: number; createdAt: Date; userId: string | null; projectId: string | null };
const events: Ev[] = [];
const orgs = new Map<string, { type: string; monthlyBudgetCents: number | null; claudeCredential: { id: string; token: string } | null }>();
const projects = new Map<string, { orgId: string | null }>();

const inRange = (e: Ev, where: any) =>
  e.orgId === where.orgId &&
  (where.sessionId === undefined || e.sessionId === where.sessionId) &&
  (!where.createdAt || (e.createdAt >= where.createdAt.gte && e.createdAt < where.createdAt.lt));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    usageEvent: {
      aggregate: vi.fn(async ({ where }: any) => {
        const rows = events.filter((e) => inRange(e, where));
        return { _sum: { costUsd: rows.length ? rows.reduce((a, e) => a + e.costUsd, 0) : null, costEurCents: rows.length ? rows.reduce((a, e) => a + e.costEurCents, 0) : null } };
      }),
      create: vi.fn(async ({ data }: any) => { events.push({ createdAt: new Date(), ...data }); return data; }),
    },
    organization: {
      findUnique: vi.fn(async ({ where }: any) => orgs.get(where.id) ?? null),
    },
    project: {
      findUnique: vi.fn(async ({ where }: any) => {
        const p = projects.get(where.id);
        if (!p) return null;
        return { orgId: p.orgId, organization: p.orgId ? { type: orgs.get(p.orgId)?.type } : null };
      }),
    },
    claudeCredential: { update: vi.fn(async () => ({})) },
  },
}));
vi.mock('@/lib/crypto', () => ({ decrypt: (s: string) => s, encrypt: (s: string) => s }));
vi.mock('@/lib/services/fx', () => ({
  usdToEurCents: async (usd: number) => Math.round(usd * 0.9 * 100),
  eurCentsToUsd: async (cents: number) => cents / 100 / 0.9,
}));
vi.mock('@/lib/services/claude-credentials', () => ({ resolveProjectClaudeToken: vi.fn(async () => null) }));

import { recordRunUsage, getBudgetStatus, periodBounds } from './org-budget';
import { resolveAgentRun, AgentRunRefusedError } from './agent-billing';

beforeEach(() => {
  events.length = 0;
  orgs.clear();
  projects.clear();
  orgs.set('micros', { type: 'klant', monthlyBudgetCents: 5000, claudeCredential: { id: 'c1', token: 'sk-ant-api03-test' } });
  orgs.set('newstory', { type: 'intern', monthlyBudgetCents: null, claudeCredential: null });
  projects.set('site', { orgId: 'micros' });
  projects.set('internal', { orgId: 'newstory' });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-platform';
});

describe('credits ledger', () => {
  it('books only the increment of a resumed session', async () => {
    expect(await recordRunUsage({ orgId: 'micros', sessionId: 's1', cumulativeCostUsd: 1.0 })).toBeCloseTo(1.0);
    expect(await recordRunUsage({ orgId: 'micros', sessionId: 's1', cumulativeCostUsd: 1.5 })).toBeCloseTo(0.5);
    expect(await recordRunUsage({ orgId: 'micros', sessionId: 's1', cumulativeCostUsd: 1.5 })).toBe(0);
    const status = await getBudgetStatus('micros');
    expect(status.spentCents).toBe(135); // 1.5 USD * 0.9
  });

  it('books the full amount after a session reset (/clear)', async () => {
    await recordRunUsage({ orgId: 'micros', sessionId: 's2', cumulativeCostUsd: 2.0 });
    expect(await recordRunUsage({ orgId: 'micros', sessionId: 's2', cumulativeCostUsd: 0.3 })).toBeCloseTo(0.3);
  });

  it('computes calendar-month periods that reset on the 1st', () => {
    const { start, end } = periodBounds(new Date('2026-09-25T10:00:00Z'));
    expect(start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('run gating', () => {
  it('runs a customer project on the org key with the remaining budget as cap', async () => {
    await recordRunUsage({ orgId: 'micros', sessionId: 's', cumulativeCostUsd: 10 }); // 900 cents spent
    const run = await resolveAgentRun('site', 'user-1');
    expect(run.token).toBe('sk-ant-api03-test');
    expect(run.billing).toEqual({ orgId: 'micros', projectId: 'site', userId: 'user-1' });
    expect(run.maxBudgetUsd).toBeCloseTo(4100 / 100 / 0.9);
  });

  it('refuses once the budget is used up', async () => {
    await recordRunUsage({ orgId: 'micros', sessionId: 's', cumulativeCostUsd: 60 }); // > €50
    await expect(resolveAgentRun('site', 'user-1')).rejects.toBeInstanceOf(AgentRunRefusedError);
  });

  it('never falls back to the platform token for a customer org without a key', async () => {
    orgs.set('micros', { type: 'klant', monthlyBudgetCents: 5000, claudeCredential: null });
    await expect(resolveAgentRun('site', 'user-1')).rejects.toThrow(/no Anthropic API key/);
  });

  it('leaves internal projects on the existing chain (platform token fallback, no billing)', async () => {
    const run = await resolveAgentRun('internal', 'user-1');
    expect(run.token).toBe('sk-ant-oat-platform');
    expect(run.billing).toBeUndefined();
    expect(run.maxBudgetUsd).toBeUndefined();
  });
});
