/**
 * Book an agent run's result message (SDK `result` / CLI stream-json `result`)
 * in the organisation's credits ledger.
 */
import type { RunBilling } from '@/lib/services/agent-billing';
import { recordRunUsage } from '@/lib/services/org-budget';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export async function bookRunResult(billing: RunBilling, message: unknown): Promise<void> {
  if (!message || typeof message !== 'object') return;
  const m = message as Record<string, unknown>;
  const usage = (m.usage && typeof m.usage === 'object' ? m.usage : {}) as Record<string, unknown>;
  const modelUsage = m.modelUsage && typeof m.modelUsage === 'object' ? Object.keys(m.modelUsage as object) : [];
  await recordRunUsage({
    orgId: billing.orgId,
    projectId: billing.projectId,
    userId: billing.userId,
    sessionId: typeof m.session_id === 'string' ? m.session_id : null,
    source: 'agent',
    model: modelUsage[0] ?? null,
    cumulativeCostUsd: num(m.total_cost_usd),
    inputTokens: num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
    outputTokens: num(usage.output_tokens),
  });
}
