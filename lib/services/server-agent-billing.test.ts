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

import { getBudgetStatus, isBudgetExhausted, MIN_RUN_BUDGET_CENTS, recordRunUsage } from './org-budget';
import { checkAgentRunAllowed, describeRunRefusal, resolveAgentRun, runsOnOwnToken, AgentRunRefusedError } from './agent-billing';
import { resolveRequestLocale } from './server-i18n';

beforeEach(() => {
  events.length = 0;
  orgs.clear();
  projects.clear();
  users.clear();
  personal.clear();
  orgs.set('acme', { type: 'klant', monthlyBudgetCents: 5000, claudeCredential: { id: 'c1', token: 'sk-ant-api03-test' } });
  orgs.set('newstory', { type: 'intern', monthlyBudgetCents: null, claudeCredential: null });
  projects.set('site', { orgId: 'acme' });
  projects.set('internal', { orgId: 'newstory' });
  users.set('customer', { id: 'customer', role: 'user', internal: false });
  users.set('staffer', { id: 'staffer', role: 'user', internal: true });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-platform';
});

/** Book exactly `cents` of budgeted spend (0.9 EUR per USD in the fx mock). */
async function spend(cents: number) {
  events.push({ orgId: 'acme', sessionId: null, costUsd: cents / 90, costEurCents: cents, billedEurCents: cents, marginPercent: 0, createdAt: new Date(), userId: null, projectId: 'site' });
}

describe('one shared "budget used up" threshold', () => {
  it('isBudgetExhausted: below the minimum run budget, never for no limit', () => {
    expect(isBudgetExhausted(null)).toBe(false);
    expect(isBudgetExhausted(MIN_RUN_BUDGET_CENTS)).toBe(false);
    expect(isBudgetExhausted(MIN_RUN_BUDGET_CENTS - 1)).toBe(true);
    expect(isBudgetExhausted(0)).toBe(true);
  });

  it('a few cents left: the meter says exhausted AND the run is refused (no disagreement)', async () => {
    await spend(5000 - (MIN_RUN_BUDGET_CENTS - 2));
    const status = await getBudgetStatus('acme');
    expect(status.remainingCents).toBe(MIN_RUN_BUDGET_CENTS - 2);
    expect(status.exhausted).toBe(true);
    await expect(resolveAgentRun('site', 'customer')).rejects.toBeInstanceOf(AgentRunRefusedError);
  });

  it('exactly the minimum left: neither exhausted nor refused', async () => {
    await spend(5000 - MIN_RUN_BUDGET_CENTS);
    expect((await getBudgetStatus('acme')).exhausted).toBe(false);
    await expect(resolveAgentRun('site', 'customer')).resolves.toMatchObject({ token: 'sk-ant-api03-test' });
  });
});

describe('translatable refusals', () => {
  it('checkAgentRunAllowed returns a code, ISO params and an i18n key', async () => {
    await recordRunUsage({ orgId: 'acme', sessionId: 's', cumulativeCostUsd: 60 });
    const refusal = await checkAgentRunAllowed('site', 'customer');
    expect(refusal?.code).toBe('budget_exhausted');
    expect(refusal?.messageKey).toBe('server.refusal.budgetExhausted');
    expect(refusal?.params.resetsAt).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  });

  it('checkAgentRunAllowed: null when the run may start (incl. staff past the budget)', async () => {
    expect(await checkAgentRunAllowed('site', 'customer')).toBeNull();
    await recordRunUsage({ orgId: 'acme', sessionId: 's', cumulativeCostUsd: 60 });
    expect(await checkAgentRunAllowed('site', 'staffer')).toBeNull();
    expect(await checkAgentRunAllowed('internal', 'customer')).toBeNull();
  });

  it('no org key is refused with its own code', async () => {
    orgs.set('acme', { type: 'klant', monthlyBudgetCents: 5000, claudeCredential: null });
    expect((await checkAgentRunAllowed('site', 'customer'))?.code).toBe('no_org_credential');
  });

  it('formats the reset date in the viewer language', () => {
    const params = { resetsAt: '2026-11-01T00:00:00.000Z' };
    expect(describeRunRefusal('budget_exhausted', params, 'en')).toContain('1 November');
    expect(describeRunRefusal('budget_exhausted', params, 'nl')).toContain('1 november');
    expect(describeRunRefusal('budget_exhausted', params, 'de')).toContain('1. November');
    expect(describeRunRefusal('budget_exhausted', params, 'fr')).toContain('1 novembre');
    expect(describeRunRefusal('budget_exhausted', params, 'nl')).not.toContain('{date}');
  });
});

describe('own Claude account for the credits meter', () => {
  it('true only for a customer with an own account in an org that allows it', async () => {
    personal.set('customer', 'sk-ant-oat-own');
    expect(await runsOnOwnToken('site', 'customer')).toBe(false); // not allowed yet
    orgs.set('acme', { ...orgs.get('acme')!, allowOwnToken: true });
    expect(await runsOnOwnToken('site', 'customer')).toBe(true);
    expect(await runsOnOwnToken('site', 'staffer')).toBe(false);
    expect(await runsOnOwnToken('internal', 'customer')).toBe(false);
    expect(await runsOnOwnToken('site', null)).toBe(false);
  });
});

describe('resolveRequestLocale', () => {
  it('account preference > body > Accept-Language > en', () => {
    expect(resolveRequestLocale({ userLocale: 'de', bodyLocale: 'fr', acceptLanguage: 'nl' })).toBe('de');
    expect(resolveRequestLocale({ userLocale: null, bodyLocale: 'fr', acceptLanguage: 'nl' })).toBe('fr');
    expect(resolveRequestLocale({ acceptLanguage: 'es-ES,nl-NL;q=0.8,en;q=0.5' })).toBe('nl');
    expect(resolveRequestLocale({ userLocale: 'xx', bodyLocale: 7 })).toBe('en');
  });
});
