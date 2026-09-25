/**
 * Organisation credits (monthly agent budget + usage).
 *   GET /api/orgs/:org_id/credits?month=0   -> { status, usage }   (any member; per-person split for
 *                                                                   eigenaar/beheerder/superadmin only)
 *   PUT /api/orgs/:org_id/credits           -> { monthlyBudgetEur?: number | null, creditMarginPercent?: number }   (superadmin)
 * The margin and the raw token cost are only returned to superadmins; members see billed amounts.
 * `month` is 0 for the current calendar month, -1 for the previous one, … (max 12 back).
 */
import { NextRequest } from 'next/server';
import { requireOrgMember, isOrgAdminRole } from '@/lib/services/org-access';
import { getBudgetStatus, getUsageBreakdown, setMonthlyBudget, setCreditMargin, getCreditMarginPercent, MAX_CREDIT_MARGIN_PERCENT } from '@/lib/services/org-budget';
import { recordAudit } from '@/lib/services/audit';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ org_id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const { org_id } = await params;
    const gate = await requireOrgMember(org_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);
    const raw = Number(req.nextUrl.searchParams.get('month') ?? 0);
    const month = Number.isInteger(raw) && raw <= 0 && raw >= -12 ? raw : 0;
    const [status, usage, marginPercent] = await Promise.all([getBudgetStatus(org_id), getUsageBreakdown(org_id, month), getCreditMarginPercent(org_id)]);
    const seesPeople = gate.actor.superadmin || isOrgAdminRole(gate.actor.role);
    const { costCents, ...billed } = usage;
    return createSuccessResponse({
      status,
      usage: seesPeople ? billed : { ...billed, byUser: [], staffCents: 0 },
      canEditBudget: gate.actor.superadmin,
      ...(gate.actor.superadmin ? { marginPercent, costCents } : {}),
    });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to read organisation credits');
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const { org_id } = await params;
    const gate = await requireOrgMember(org_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);
    if (!gate.actor.superadmin) return createErrorResponse('forbidden', 'Only a superadmin can set the budget', 403);
    const body = (await req.json().catch(() => null)) ?? {};
    const hasBudget = 'monthlyBudgetEur' in body;
    const hasMargin = 'creditMarginPercent' in body;
    if (!hasBudget && !hasMargin) {
      return createErrorResponse('invalid_input', 'Provide monthlyBudgetEur and/or creditMarginPercent', 400);
    }
    const eur = body.monthlyBudgetEur;
    if (hasBudget && eur !== null && (typeof eur !== 'number' || !Number.isFinite(eur) || eur < 0 || eur > 1_000_000)) {
      return createErrorResponse('invalid_input', 'monthlyBudgetEur must be a number between 0 and 1,000,000, or null', 400);
    }
    const margin = body.creditMarginPercent;
    if (hasMargin && (typeof margin !== 'number' || !Number.isInteger(margin) || margin < 0 || margin > MAX_CREDIT_MARGIN_PERCENT)) {
      return createErrorResponse('invalid_input', `creditMarginPercent must be a whole number between 0 and ${MAX_CREDIT_MARGIN_PERCENT}`, 400);
    }
    if (hasBudget) {
      const cents = eur === null ? null : Math.round(eur * 100);
      await setMonthlyBudget(org_id, cents);
      await recordAudit({ orgId: org_id, actor: gate.actor.user, action: 'org.budget.set', targetType: 'org', targetId: org_id, meta: { monthlyBudgetCents: cents } });
    }
    if (hasMargin) {
      await setCreditMargin(org_id, margin);
      await recordAudit({ orgId: org_id, actor: gate.actor.user, action: 'org.margin.set', targetType: 'org', targetId: org_id, meta: { creditMarginPercent: margin } });
    }
    return createSuccessResponse({ status: await getBudgetStatus(org_id), marginPercent: await getCreditMarginPercent(org_id) });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to set the budget');
  }
}
