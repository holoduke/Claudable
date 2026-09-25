/**
 * Organisation credits (monthly agent budget + usage).
 *   GET /api/orgs/:org_id/credits?month=0   -> { status, usage }   (any member; per-person split for
 *                                                                   eigenaar/beheerder/superadmin only)
 *   PUT /api/orgs/:org_id/credits           -> { monthlyBudgetEur: number | null }   (superadmin)
 * `month` is 0 for the current calendar month, -1 for the previous one, … (max 12 back).
 */
import { NextRequest } from 'next/server';
import { requireOrgMember, isOrgAdminRole } from '@/lib/services/org-access';
import { getBudgetStatus, getUsageBreakdown, setMonthlyBudget } from '@/lib/services/org-budget';
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
    const [status, usage] = await Promise.all([getBudgetStatus(org_id), getUsageBreakdown(org_id, month)]);
    const seesPeople = gate.actor.superadmin || isOrgAdminRole(gate.actor.role);
    return createSuccessResponse({
      status,
      usage: seesPeople ? usage : { ...usage, byUser: [] },
      canEditBudget: gate.actor.superadmin,
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
    const eur = body.monthlyBudgetEur;
    if (eur !== null && (typeof eur !== 'number' || !Number.isFinite(eur) || eur < 0 || eur > 1_000_000)) {
      return createErrorResponse('invalid_input', 'monthlyBudgetEur must be a number between 0 and 1,000,000, or null', 400);
    }
    const cents = eur === null ? null : Math.round(eur * 100);
    await setMonthlyBudget(org_id, cents);
    await recordAudit({ orgId: org_id, actor: gate.actor.user, action: 'org.budget.set', targetType: 'org', targetId: org_id, meta: { monthlyBudgetCents: cents } });
    return createSuccessResponse({ status: await getBudgetStatus(org_id) });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to set the budget');
  }
}
