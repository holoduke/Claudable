import { beforeEach, describe, expect, it, vi } from 'vitest';

// Credits ledger + run gating for customer orgs, with Prisma, FX and crypto mocked.
type Ev = { orgId: string; sessionId: string | null; costUsd: number; costEurCents: number; billedEurCents: number; marginPercent: number; createdAt: Date; userId: string | null; projectId: string | null; source?: string };
const events: Ev[] = [];
const personal = new Map<string, string>();
const orgs = new Map<string, { type: string; monthlyBudgetCents: number | null; creditMarginPercent?: number; allowOwnToken?: boolean; claudeCredential: { id: string; token: string } | null }>();
const projects = new Map<string, { orgId: string | null }>();
const users = new Map<string, { id: string; role: string; internal: boolean }>();

const inRange = (e: Ev, where: any) =>
  e.orgId === where.orgId &&
  (where.sessionId === undefined || e.sessionId === where.sessionId) &&
  (!where.createdAt || (e.createdAt >= where.createdAt.gte && e.createdAt < where.createdAt.lt)) &&
  (!where.source || !where.source.notIn.includes(e.source ?? 'agent'));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    usageEvent: {
      aggregate: vi.fn(async ({ where }: any) => {
        const rows = events.filter((e) => inRange(e, where));
        return { _sum: { costUsd: rows.length ? rows.reduce((a, e) => a + e.costUsd, 0) : null, costEurCents: rows.length ? rows.reduce((a, e) => a + e.costEurCents, 0) : null, billedEurCents: rows.length ? rows.reduce((a, e) => a + e.billedEurCents, 0) : null } };
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
    user: { findUnique: vi.fn(async ({ where }: any) => users.get(where.id) ?? null) },
    orgMember: { findFirst: vi.fn(async ({ where }: any) => (users.get(where.userId)?.internal ? { id: 'm' } : null)) },
  },
}));
vi.mock('@/lib/crypto', () => ({ decrypt: (s: string) => s, encrypt: (s: string) => s }));
vi.mock('@/lib/services/fx', () => ({
  usdToEurCents: async (usd: number) => Math.round(usd * 0.9 * 100),
  eurCentsToUsd: async (cents: number) => cents / 100 / 0.9,
}));
vi.mock('@/lib/services/claude-credentials', () => ({
  resolveProjectClaudeToken: vi.fn(async () => null),
  resolvePersonalClaudeToken: vi.fn(async (id: string) => personal.get(id) ?? null),
}));

import { recordRunUsage, getBudgetStatus, periodBounds, setCreditMargin } from './org-budget';
import { resolveAgentRun, AgentRunRefusedError } from './agent-billing';

beforeEach(() => {
  events.length = 0;
  orgs.clear();
  projects.clear();
  orgs.set('acme', { type: 'klant', monthlyBudgetCents: 5000, claudeCredential: { id: 'c1', token: 'sk-ant-api03-test' } });
  orgs.set('newstory', { type: 'intern', monthlyBudgetCents: null, claudeCredential: null });
  projects.set('site', { orgId: 'acme' });
  projects.set('internal', { orgId: 'newstory' });
  users.clear();
  personal.clear();
  users.set('customer', { id: 'customer', role: 'user', internal: false });
  users.set('staffer', { id: 'staffer', role: 'user', internal: true });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-platform';
});

describe('credits ledger', () => {
  it('books only the increment of a resumed session', async () => {
    expect(await recordRunUsage({ orgId: 'acme', sessionId: 's1', cumulativeCostUsd: 1.0 })).toBeCloseTo(1.0);
    expect(await recordRunUsage({ orgId: 'acme', sessionId: 's1', cumulativeCostUsd: 1.5 })).toBeCloseTo(0.5);
    expect(await recordRunUsage({ orgId: 'acme', sessionId: 's1', cumulativeCostUsd: 1.5 })).toBe(0);
    const status = await getBudgetStatus('acme');
    expect(status.spentCents).toBe(135); // 1.5 USD * 0.9
  });

  it('books the full amount after a session reset (/clear)', async () => {
    await recordRunUsage({ orgId: 'acme', sessionId: 's2', cumulativeCostUsd: 2.0 });
    expect(await recordRunUsage({ orgId: 'acme', sessionId: 's2', cumulativeCostUsd: 0.3 })).toBeCloseTo(0.3);
  });

  it('computes calendar-month periods that reset on the 1st', () => {
    const { start, end } = periodBounds(new Date('2026-09-25T10:00:00Z'));
    expect(start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('credit margin', () => {
  it('books cost plus the org margin and counts the billed amount against the budget', async () => {
    orgs.set('acme', { ...orgs.get('acme')!, creditMarginPercent: 10 });
    await recordRunUsage({ orgId: 'acme', sessionId: 'm1', cumulativeCostUsd: 1.0 }); // 90 cents cost
    const ev = events[events.length - 1];
    expect(ev.costEurCents).toBe(90);
    expect(ev.billedEurCents).toBe(99);
    expect(ev.marginPercent).toBe(10);
    expect((await getBudgetStatus('acme')).spentCents).toBe(99);
  });

  it('bills at cost without a margin', async () => {
    await recordRunUsage({ orgId: 'acme', sessionId: 'm2', cumulativeCostUsd: 1.0 });
    expect(events[events.length - 1].billedEurCents).toBe(90);
  });

  it('caps a run so cost plus margin fits the remaining budget', async () => {
    orgs.set('acme', { ...orgs.get('acme')!, creditMarginPercent: 10 });
    await recordRunUsage({ orgId: 'acme', sessionId: 's', cumulativeCostUsd: 10 }); // 900 cost, 990 billed
    const run = await resolveAgentRun('site', 'customer');
    expect(run.maxBudgetUsd).toBeCloseTo((5000 - 990) / 1.1 / 100 / 0.9);
  });

  it('rejects an invalid margin', async () => {
    await expect(setCreditMargin('acme', -5)).rejects.toThrow();
    await expect(setCreditMargin('acme', 10.5)).rejects.toThrow();
    await expect(setCreditMargin('acme', 500)).rejects.toThrow();
  });
});

describe('run gating', () => {
  it('runs a customer project on the org key with the remaining budget as cap', async () => {
    await recordRunUsage({ orgId: 'acme', sessionId: 's', cumulativeCostUsd: 10 }); // 900 cents spent
    const run = await resolveAgentRun('site', 'customer');
    expect(run.token).toBe('sk-ant-api03-test');
    expect(run.billing).toEqual({ orgId: 'acme', projectId: 'site', userId: 'customer' });
    expect(run.maxBudgetUsd).toBeCloseTo(4100 / 100 / 0.9);
  });

  it('refuses once the budget is used up', async () => {
    await recordRunUsage({ orgId: 'acme', sessionId: 's', cumulativeCostUsd: 60 }); // > €50
    await expect(resolveAgentRun('site', 'customer')).rejects.toBeInstanceOf(AgentRunRefusedError);
  });

  it('never falls back to the platform token for a customer org without a key', async () => {
    orgs.set('acme', { type: 'klant', monthlyBudgetCents: 5000, claudeCredential: null });
    await expect(resolveAgentRun('site', 'customer')).rejects.toThrow(/no Anthropic API key/);
  });

  it('runs New Story staff on the org key outside the customer budget', async () => {
    await recordRunUsage({ orgId: 'acme', sessionId: 's', cumulativeCostUsd: 60 }); // customer budget used up
    const run = await resolveAgentRun('site', 'staffer');
    expect(run.token).toBe('sk-ant-api03-test');
    expect(run.billing).toEqual({ orgId: 'acme', projectId: 'site', userId: 'staffer', staff: true });
    expect(run.maxBudgetUsd).toBeUndefined();
    const before = (await getBudgetStatus('acme')).spentCents;
    await recordRunUsage({ orgId: 'acme', sessionId: 'staff-1', source: 'staff', cumulativeCostUsd: 5 });
    events[events.length - 1].source = 'staff';
    expect((await getBudgetStatus('acme')).spentCents).toBe(before);
  });

  it('leaves internal projects on the existing chain (platform token fallback, no billing)', async () => {
    const run = await resolveAgentRun('internal', 'user-1');
    expect(run.token).toBe('sk-ant-oat-platform');
    expect(run.billing).toBeUndefined();
    expect(run.maxBudgetUsd).toBeUndefined();
  });
});

describe('own Claude account', () => {
  it('runs a customer on their own account when the org allows it — outside the budget, at cost', async () => {
    orgs.set('acme', { ...orgs.get('acme')!, allowOwnToken: true, creditMarginPercent: 10 });
    personal.set('customer', 'sk-ant-oat-own');
    await recordRunUsage({ orgId: 'acme', sessionId: 's', cumulativeCostUsd: 60 }); // budget used up
    const run = await resolveAgentRun('site', 'customer');
    expect(run.token).toBe('sk-ant-oat-own');
    expect(run.billing).toEqual({ orgId: 'acme', projectId: 'site', userId: 'customer', ownToken: true });
    expect(run.maxBudgetUsd).toBeUndefined();
    const before = (await getBudgetStatus('acme')).spentCents;
    await recordRunUsage({ orgId: 'acme', sessionId: 'own-1', source: 'own', cumulativeCostUsd: 1 });
    const ev = events[events.length - 1];
    expect(ev.billedEurCents).toBe(ev.costEurCents);
    expect((await getBudgetStatus('acme')).spentCents).toBe(before);
  });

  it('falls back to the org key and budget without an own account', async () => {
    orgs.set('acme', { ...orgs.get('acme')!, allowOwnToken: true });
    const run = await resolveAgentRun('site', 'customer');
    expect(run.token).toBe('sk-ant-api03-test');
    expect(run.billing?.ownToken).toBeUndefined();
  });

  it('ignores an own account when the org does not allow it', async () => {
    personal.set('customer', 'sk-ant-oat-own');
    const run = await resolveAgentRun('site', 'customer');
    expect(run.token).toBe('sk-ant-api03-test');
  });
});
