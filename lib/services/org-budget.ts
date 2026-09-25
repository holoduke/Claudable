/**
 * Organisation credits: the monthly agent budget and the usage ledger.
 *
 * Every agent run of a customer organisation is booked as UsageEvent rows. The
 * CLI reports a CUMULATIVE cost per session (a resumed session continues from the
 * total its transcript saved), so each result is booked as the increment over
 * what was already booked for that session. Months are calendar months in UTC;
 * the budget resets on the 1st.
 *
 * Runs by New Story staff inside a customer project are booked with source
 * 'staff', and customer runs on their own Claude account with source 'own'
 * (at cost, no margin): both visible, but NOT counted against the budget.
 *
 * Each event stores the token cost (costEurCents) and the billed amount
 * (billedEurCents = cost + the org's margin at booking time). Everything the
 * customer sees, and the budget, uses the billed amount; the raw cost is only
 * shown to superadmins. Changing the margin never rewrites past events.
 */
import { prisma } from '@/lib/db/client';
import { usdToEurCents } from '@/lib/services/fx';

export interface BudgetStatus {
  orgId: string;
  budgetCents: number | null; // null = no limit
  spentCents: number;
  remainingCents: number | null; // null = no limit
  exhausted: boolean;
  periodStart: string; // ISO
  resetsAt: string; // ISO — the next period start
}

export function periodBounds(now = new Date(), monthOffset = 0): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset + 1, 1));
  return { start, end };
}

export const STAFF_SOURCE = 'staff';
export const OWN_TOKEN_SOURCE = 'own';
const UNBUDGETED_SOURCES = [STAFF_SOURCE, OWN_TOKEN_SOURCE];

/** Budgeted spend: everything except staff runs and runs on the customer's own account. */
async function spentCentsBetween(orgId: string, start: Date, end: Date): Promise<number> {
  const agg = await prisma.usageEvent.aggregate({
    where: { orgId, createdAt: { gte: start, lt: end }, source: { notIn: UNBUDGETED_SOURCES } },
    _sum: { billedEurCents: true },
  });
  return agg._sum.billedEurCents ?? 0;
}

export async function getBudgetStatus(orgId: string, now = new Date()): Promise<BudgetStatus> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { monthlyBudgetCents: true } });
  const { start, end } = periodBounds(now);
  const spentCents = await spentCentsBetween(orgId, start, end);
  const budgetCents = org?.monthlyBudgetCents ?? null;
  const remainingCents = budgetCents === null ? null : Math.max(0, budgetCents - spentCents);
  return {
    orgId,
    budgetCents,
    spentCents,
    remainingCents,
    exhausted: remainingCents !== null && remainingCents <= 0,
    periodStart: start.toISOString(),
    resetsAt: end.toISOString(),
  };
}

export async function setMonthlyBudget(orgId: string, budgetCents: number | null): Promise<void> {
  if (budgetCents !== null && (!Number.isInteger(budgetCents) || budgetCents < 0 || budgetCents > 100_000_000)) {
    throw new Error('Budget must be a whole number of cents between 0 and 1,000,000 euro');
  }
  await prisma.organization.update({ where: { id: orgId }, data: { monthlyBudgetCents: budgetCents } });
}

export const MAX_CREDIT_MARGIN_PERCENT = 200;

export async function setCreditMargin(orgId: string, percent: number): Promise<void> {
  if (!Number.isInteger(percent) || percent < 0 || percent > MAX_CREDIT_MARGIN_PERCENT) {
    throw new Error(`Margin must be a whole percentage between 0 and ${MAX_CREDIT_MARGIN_PERCENT}`);
  }
  await prisma.organization.update({ where: { id: orgId }, data: { creditMarginPercent: percent } });
}

/** The org's current margin in whole percent (0 when unset). */
export async function getCreditMarginPercent(orgId: string): Promise<number> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { creditMarginPercent: true } });
  return org?.creditMarginPercent ?? 0;
}

export function withMargin(cents: number, marginPercent: number): number {
  return Math.round(cents * (1 + marginPercent / 100));
}

export interface RunUsageInput {
  orgId: string;
  projectId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  source?: 'agent' | 'design' | 'staff' | 'own';
  model?: string | null;
  /** Cumulative cost the CLI reports for this session so far (total_cost_usd). */
  cumulativeCostUsd: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Book one run result. Returns the booked increment in USD (0 when nothing new). */
export async function recordRunUsage(input: RunUsageInput): Promise<number> {
  const cumulative = Number.isFinite(input.cumulativeCostUsd) ? Math.max(0, input.cumulativeCostUsd) : 0;
  let increment = cumulative;
  if (input.sessionId) {
    const booked = await prisma.usageEvent.aggregate({
      where: { orgId: input.orgId, sessionId: input.sessionId },
      _sum: { costUsd: true },
    });
    const already = booked._sum.costUsd ?? 0;
    // A running total below what we booked means the session was reset
    // (/clear, fork): the whole reported amount is new spend.
    increment = cumulative >= already ? cumulative - already : cumulative;
  }
  if (increment <= 0) return 0;
  // No margin on the customer's own account: New Story does not pay for it.
  const [costEurCents, marginPercent] = await Promise.all([
    usdToEurCents(increment),
    input.source === OWN_TOKEN_SOURCE ? 0 : getCreditMarginPercent(input.orgId),
  ]);
  await prisma.usageEvent.create({
    data: {
      orgId: input.orgId,
      projectId: input.projectId ?? null,
      userId: input.userId ?? null,
      sessionId: input.sessionId ?? null,
      source: input.source ?? 'agent',
      model: input.model ?? null,
      costUsd: increment,
      costEurCents,
      billedEurCents: withMargin(costEurCents, marginPercent),
      marginPercent,
      inputTokens: Math.max(0, Math.round(input.inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.round(input.outputTokens ?? 0)),
    },
  });
  return increment;
}

export interface UsageBreakdown {
  periodStart: string;
  periodEnd: string;
  /** Budgeted usage (excludes staff). */
  totalCents: number;
  runs: number;
  /** New Story staff usage in this org's projects (not budgeted). */
  staffCents: number;
  /** Token cost of the budgeted usage, before margin (superadmin only). */
  costCents: number;
  /** Customer runs on their own Claude account (at cost, not budgeted). */
  ownCents: number;
  byUser: Array<{ userId: string | null; name: string; email: string | null; cents: number; runs: number; staff: boolean }>;
  byProject: Array<{ projectId: string | null; name: string; cents: number; runs: number }>;
  byDay: Array<{ day: string; cents: number }>;
}

/** Usage of an org in a month (0 = current, -1 = previous, …) for the credits overview. */
export async function getUsageBreakdown(orgId: string, monthOffset = 0, now = new Date()): Promise<UsageBreakdown> {
  const { start, end } = periodBounds(now, monthOffset);
  const events = await prisma.usageEvent.findMany({
    where: { orgId, createdAt: { gte: start, lt: end } },
    select: { userId: true, projectId: true, costEurCents: true, billedEurCents: true, createdAt: true, source: true },
  });
  const staffIds = new Set(events.filter((e) => e.source === STAFF_SOURCE && e.userId).map((e) => e.userId as string));
  const budgeted = events.filter((e) => !UNBUDGETED_SOURCES.includes(e.source));
  const ownRuns = events.filter((e) => e.source === OWN_TOKEN_SOURCE);
  const onKey = events.filter((e) => e.source !== OWN_TOKEN_SOURCE);

  const sum = <K>(key: (e: (typeof events)[number]) => K, list: typeof events = events) => {
    const map = new Map<K, { cents: number; runs: number }>();
    for (const e of list) {
      const k = key(e);
      const cur = map.get(k) ?? { cents: 0, runs: 0 };
      map.set(k, { cents: cur.cents + e.billedEurCents, runs: cur.runs + 1 });
    }
    return map;
  };

  // People: everyone on the org key (staff tagged). Projects and days: budgeted
  // usage only, so they add up to the budget total.
  const userTotals = sum((e) => e.userId, onKey);
  const projectTotals = sum((e) => e.projectId, budgeted);
  const dayTotals = sum((e) => e.createdAt.toISOString().slice(0, 10), budgeted);
  const budgetedCents = budgeted.reduce((acc, e) => acc + e.billedEurCents, 0);

  const userIds = [...userTotals.keys()].filter((id): id is string => !!id);
  const projectIds = [...projectTotals.keys()].filter((id): id is string => !!id);
  const [users, projects] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
    // Only the org's own projects are named (a moved project keeps its history but not a foreign name).
    prisma.project.findMany({ where: { id: { in: projectIds }, orgId }, select: { id: true, name: true } }),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const projectById = new Map(projects.map((p) => [p.id, p]));

  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    totalCents: budgetedCents,
    runs: budgeted.length,
    staffCents: onKey.reduce((acc, e) => acc + e.billedEurCents, 0) - budgetedCents,
    ownCents: ownRuns.reduce((acc, e) => acc + e.billedEurCents, 0),
    costCents: budgeted.reduce((acc, e) => acc + e.costEurCents, 0),
    byUser: [...userTotals.entries()]
      .map(([userId, t]) => {
        const u = userId ? userById.get(userId) : undefined;
        return { userId, name: u?.name || u?.email || 'Unknown', email: u?.email ?? null, staff: !!userId && staffIds.has(userId), ...t };
      })
      .sort((a, b) => b.cents - a.cents),
    byProject: [...projectTotals.entries()]
      .map(([projectId, t]) => ({ projectId, name: (projectId && projectById.get(projectId)?.name) || 'Other project', ...t }))
      .sort((a, b) => b.cents - a.cents),
    byDay: [...dayTotals.entries()].map(([day, t]) => ({ day, cents: t.cents })).sort((a, b) => a.day.localeCompare(b.day)),
  };
}
