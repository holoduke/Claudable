/**
 * Which credential an agent run uses, and under which budget.
 *
 * Internal projects: unchanged — the project/personal/org credential chain,
 * falling back to the platform token (resolveProjectClaudeToken + env).
 *
 * CUSTOMER projects are strict:
 *  - they run ONLY on their organisation's own credential (an Anthropic API key);
 *    never on a person's credential and never on New Story's platform token — so
 *    every run is billed to, and counted against, the organisation;
 *  - a run is refused once the monthly budget is used up, and otherwise gets the
 *    remaining budget as a hard per-run cap (the CLI's --max-budget-usd), so a
 *    single long run cannot overshoot it;
 *  - New Story staff working in a customer project also run on the org's key
 *    (never on the platform token inside a customer container), but outside the
 *    customer's budget: booked as 'staff', no cap, never refused for budget;
 *  - when a superadmin allows it for the org (allowOwnToken), a customer who
 *    connected their OWN Claude account runs on that instead: booked as 'own'
 *    (visible, at cost), never counted against the budget or capped. Without
 *    their own account they fall back to the org key and budget.
 */
import { prisma } from '@/lib/db/client';
import { decrypt } from '@/lib/crypto';
import { resolveProjectClaudeToken, resolvePersonalClaudeToken } from '@/lib/services/claude-credentials';
import { isInternalUser, projectTenant } from '@/lib/services/tenant-policy';
import { getBudgetStatus, getCreditMarginPercent } from '@/lib/services/org-budget';
import { eurCentsToUsd } from '@/lib/services/fx';

export class AgentRunRefusedError extends Error {
  constructor(message: string, readonly code: 'no_org_credential' | 'budget_exhausted') {
    super(message);
    this.name = 'AgentRunRefusedError';
  }
}

/**
 * A turn that ended for a reason a retry cannot fix (no key, budget used up —
 * before or during the run). applyChanges must not retry it with a fresh session.
 */
export class AgentTurnNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTurnNonRetryableError';
  }
}

export const BUDGET_STOPPED_MESSAGE = 'This run stopped because the monthly budget of this organisation is used up.';

export interface RunBilling {
  orgId: string;
  projectId: string;
  userId: string | null;
  /** A New Story staff run: recorded, not counted against the customer budget. */
  staff?: boolean;
  /** A customer run on their own Claude account: recorded at cost, not budgeted. */
  ownToken?: boolean;
}

export interface AgentRunCredential {
  token: string;
  /** Hard cap for this run in USD (customer orgs with a budget). */
  maxBudgetUsd?: number;
  /** Set for customer orgs: book the run's cost against this organisation. */
  billing?: RunBilling;
}

// Below this remaining amount a run cannot do meaningful work: refuse instead of
// starting one that stops after a single call.
const MIN_RUN_BUDGET_CENTS = 5;

function formatResetDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export async function resolveAgentRun(projectId: string, requesterUserId?: string): Promise<AgentRunCredential> {
  const tenant = await projectTenant(projectId);

  if (!tenant.isCustomer || !tenant.orgId) {
    const token = (await resolveProjectClaudeToken(projectId, requesterUserId)) || process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
    if (!token) throw new Error('No Claude credential available (CLAUDE_CODE_OAUTH_TOKEN unset and no project credential).');
    return { token };
  }

  const org = await prisma.organization.findUnique({
    where: { id: tenant.orgId },
    select: { allowOwnToken: true, claudeCredential: { select: { id: true, token: true } } },
  });
  const requester = requesterUserId
    ? await prisma.user.findUnique({ where: { id: requesterUserId }, select: { id: true, role: true } })
    : null;
  const staff = !!requester && (await isInternalUser(requester));
  if (!staff && requester && org?.allowOwnToken) {
    const own = await resolvePersonalClaudeToken(requester.id);
    if (own) return { token: own, billing: { orgId: tenant.orgId, projectId, userId: requester.id, ownToken: true } };
  }

  let token = '';
  try {
    token = org?.claudeCredential ? decrypt(org.claudeCredential.token) : '';
  } catch {
    token = '';
  }
  if (!token) {
    throw new AgentRunRefusedError(
      'This organisation has no Anthropic API key configured yet. Ask New Story to set one up.',
      'no_org_credential',
    );
  }
  if (org?.claudeCredential) {
    prisma.claudeCredential.update({ where: { id: org.claudeCredential.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }

  if (requester && staff) {
    return { token, billing: { orgId: tenant.orgId, projectId, userId: requester.id, staff: true } };
  }

  const status = await getBudgetStatus(tenant.orgId);
  const billing: RunBilling = { orgId: tenant.orgId, projectId, userId: requesterUserId ?? null };
  if (status.remainingCents === null) return { token, billing };
  if (status.remainingCents < MIN_RUN_BUDGET_CENTS) {
    throw new AgentRunRefusedError(
      `The monthly budget for this organisation is used up. It resets on ${formatResetDate(status.resetsAt)}.`,
      'budget_exhausted',
    );
  }
  // The budget is in billed euros (cost + margin); the CLI cap is raw token cost.
  const margin = await getCreditMarginPercent(tenant.orgId);
  return { token, billing, maxBudgetUsd: await eurCentsToUsd(status.remainingCents / (1 + margin / 100)) };
}
