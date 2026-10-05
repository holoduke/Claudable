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
import { getBudgetStatus, getCreditMarginPercent, isBudgetExhausted } from '@/lib/services/org-budget';
import { eurCentsToUsd } from '@/lib/services/fx';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/config';
import { formatServerDate, serverT, type ServerMessageKey } from '@/lib/services/server-i18n';

export type AgentRunRefusalCode = 'no_org_credential' | 'budget_exhausted';

/** Placeholders of a refusal message; dates are ISO so each viewer formats them in their own language. */
export interface AgentRunRefusalParams {
  resetsAt?: string;
}

/** The i18n key per refusal code ({date} = the formatted resetsAt). */
export const REFUSAL_MESSAGE_KEYS: Record<AgentRunRefusalCode, ServerMessageKey> = {
  no_org_credential: 'server.refusal.noOrgCredential',
  budget_exhausted: 'server.refusal.budgetExhausted',
};

/** A refusal as a human sentence in `locale`. */
export function describeRunRefusal(code: AgentRunRefusalCode, params: AgentRunRefusalParams, locale: Locale = DEFAULT_LOCALE): string {
  const date = params.resetsAt ? formatServerDate(params.resetsAt, locale) : '';
  return serverT(locale, REFUSAL_MESSAGE_KEYS[code], { date });
}

export class AgentRunRefusedError extends Error {
  constructor(readonly code: AgentRunRefusalCode, readonly params: AgentRunRefusalParams = {}) {
    // The default-language text lands in the chat log when a run is refused
    // mid-flight; the act route refuses up front in the viewer's language.
    super(describeRunRefusal(code, params));
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

interface CustomerRunContext {
  orgId: string;
  org: { allowOwnToken: boolean; claudeCredential: { id: string; token: string } | null } | null;
  requester: { id: string; role: string } | null;
  staff: boolean;
}

async function customerRunContext(orgId: string, requesterUserId?: string | null): Promise<CustomerRunContext> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { allowOwnToken: true, claudeCredential: { select: { id: true, token: true } } },
  });
  const requester = requesterUserId
    ? await prisma.user.findUnique({ where: { id: requesterUserId }, select: { id: true, role: true } })
    : null;
  const staff = !!requester && (await isInternalUser(requester));
  return { orgId, org, requester, staff };
}

/** The requester's own Claude token when the org allows it and they connected one (customers only). */
async function ownTokenFor(ctx: CustomerRunContext): Promise<string | null> {
  if (ctx.staff || !ctx.requester || !ctx.org?.allowOwnToken) return null;
  return (await resolvePersonalClaudeToken(ctx.requester.id)) || null;
}

/**
 * Whether `userId`'s runs in this project go on their OWN Claude account — then
 * the organisation budget does not apply to them (the credits meter says so).
 */
export async function runsOnOwnToken(projectId: string, userId?: string | null): Promise<boolean> {
  if (!userId) return false;
  const tenant = await projectTenant(projectId);
  if (!tenant.isCustomer || !tenant.orgId) return false;
  return !!(await ownTokenFor(await customerRunContext(tenant.orgId, userId)));
}

export async function resolveAgentRun(projectId: string, requesterUserId?: string): Promise<AgentRunCredential> {
  const tenant = await projectTenant(projectId);

  if (!tenant.isCustomer || !tenant.orgId) {
    const token = (await resolveProjectClaudeToken(projectId, requesterUserId)) || process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
    if (!token) throw new Error('No Claude credential available (CLAUDE_CODE_OAUTH_TOKEN unset and no project credential).');
    return { token };
  }

  const ctx = await customerRunContext(tenant.orgId, requesterUserId);
  const { org, requester, staff } = ctx;
  const own = await ownTokenFor(ctx);
  if (own && requester) return { token: own, billing: { orgId: tenant.orgId, projectId, userId: requester.id, ownToken: true } };

  let token = '';
  try {
    token = org?.claudeCredential ? decrypt(org.claudeCredential.token) : '';
  } catch {
    token = '';
  }
  if (!token) throw new AgentRunRefusedError('no_org_credential');
  if (org?.claudeCredential) {
    prisma.claudeCredential.update({ where: { id: org.claudeCredential.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }

  if (requester && staff) {
    return { token, billing: { orgId: tenant.orgId, projectId, userId: requester.id, staff: true } };
  }

  const status = await getBudgetStatus(tenant.orgId);
  const billing: RunBilling = { orgId: tenant.orgId, projectId, userId: requesterUserId ?? null };
  if (status.remainingCents === null) return { token, billing };
  // Same rule as the credits meter's "used up" banner (org-budget.isBudgetExhausted).
  if (isBudgetExhausted(status.remainingCents)) {
    throw new AgentRunRefusedError('budget_exhausted', { resetsAt: status.resetsAt });
  }
  // The budget is in billed euros (cost + margin); the CLI cap is raw token cost.
  const margin = await getCreditMarginPercent(tenant.orgId);
  return { token, billing, maxBudgetUsd: await eurCentsToUsd(status.remainingCents / (1 + margin / 100)) };
}

export interface AgentRunRefusal {
  code: AgentRunRefusalCode;
  params: AgentRunRefusalParams;
  messageKey: ServerMessageKey;
}

/**
 * Pre-flight for the act route: would this run be refused (no org key, budget
 * used up)? Lets the route answer immediately with a translatable refusal
 * instead of starting a turn that fails in the chat log. Any other resolution
 * problem is left to the run itself (it reports it in the chat as before).
 */
export async function checkAgentRunAllowed(projectId: string, requesterUserId?: string): Promise<AgentRunRefusal | null> {
  try {
    await resolveAgentRun(projectId, requesterUserId);
    return null;
  } catch (error) {
    if (error instanceof AgentRunRefusedError) {
      return { code: error.code, params: error.params, messageKey: REFUSAL_MESSAGE_KEYS[error.code] };
    }
    return null;
  }
}
