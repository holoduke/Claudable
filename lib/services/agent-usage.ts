/**
 * Agent usage tracking — context occupancy, per-turn tokens/cost, cumulative
 * totals and subscription rate-limit windows.
 *
 * Capture points live in lib/services/cli/agent-messages.ts (shared by the
 * in-process SDK loop and the containerized runner, so both paths report).
 * State is held in-memory and write-through persisted into Project.settings
 * (JSON, under the `agentUsage` key) so a redeploy keeps the last snapshot.
 * Rate limits are ACCOUNT-wide, not per-project, so they live in a module
 * singleton and are merged into every snapshot at read/publish time.
 */
import { prisma } from '@/lib/db/client';
import { streamManager } from './stream';
import type {
  AgentRateLimits,
  AgentTurnUsage,
  AgentUsageSnapshot,
  AgentUsageTotals,
} from '@/types/agent-usage';

const DEFAULT_CONTEXT_WINDOW = 200_000;

interface ProjectUsageState {
  model?: string;
  contextWindow?: number;
  contextUsedTokens?: number;
  lastTurn?: AgentTurnUsage;
  totals: AgentUsageTotals;
  updatedAt: string;
}

const projectUsage = new Map<string, ProjectUsageState>();
let globalRateLimits: AgentRateLimits = {};

const nowIso = () => new Date().toISOString();

const emptyTotals = (): AgentUsageTotals => ({
  turns: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0,
  since: nowIso(),
});

const asNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

function buildSnapshot(projectId: string, state: ProjectUsageState): AgentUsageSnapshot {
  const contextWindow = state.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const used = state.contextUsedTokens;
  return {
    projectId,
    updatedAt: state.updatedAt,
    model: state.model,
    contextWindow,
    contextUsedTokens: used,
    contextPct:
      used !== undefined && contextWindow > 0
        ? Math.min(100, Math.round((used / contextWindow) * 1000) / 10)
        : undefined,
    lastTurn: state.lastTurn,
    totals: state.totals,
    rateLimits: Object.keys(globalRateLimits).length > 0 ? globalRateLimits : undefined,
  };
}

function publishSnapshot(projectId: string, state: ProjectUsageState): void {
  streamManager.publish(projectId, {
    type: 'agent_status',
    data: buildSnapshot(projectId, state),
  });
}

/** Persist the per-project state into Project.settings.agentUsage (best-effort). */
async function persistState(projectId: string, state: ProjectUsageState): Promise<void> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { settings: true },
    });
    if (!project) return;
    let settings: Record<string, unknown> = {};
    if (project.settings) {
      try {
        const parsed = JSON.parse(project.settings);
        if (parsed && typeof parsed === 'object') settings = parsed;
      } catch {
        // Corrupt settings JSON — keep it untouched rather than clobbering it.
        return;
      }
    }
    const nextSettings = { ...settings, agentUsage: state };
    await prisma.project.update({
      where: { id: projectId },
      data: { settings: JSON.stringify(nextSettings) },
    });
  } catch (error) {
    console.error('[AgentUsage] Failed to persist usage snapshot:', error);
  }
}

/** Load a persisted state (used when the in-memory map is cold after a restart). */
async function loadPersistedState(projectId: string): Promise<ProjectUsageState | null> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { settings: true },
    });
    if (!project?.settings) return null;
    const parsed = JSON.parse(project.settings) as Record<string, unknown>;
    const stored = parsed?.agentUsage as ProjectUsageState | undefined;
    if (!stored || typeof stored !== 'object') return null;
    return {
      model: typeof stored.model === 'string' ? stored.model : undefined,
      contextWindow: asNumber(stored.contextWindow) || undefined,
      contextUsedTokens:
        stored.contextUsedTokens === undefined ? undefined : asNumber(stored.contextUsedTokens),
      lastTurn: stored.lastTurn,
      totals: {
        ...emptyTotals(),
        ...(stored.totals && typeof stored.totals === 'object' ? stored.totals : {}),
      },
      updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : nowIso(),
    };
  } catch {
    return null;
  }
}

function getState(projectId: string): ProjectUsageState {
  const existing = projectUsage.get(projectId);
  if (existing) return existing;
  const fresh: ProjectUsageState = { totals: emptyTotals(), updatedAt: nowIso() };
  projectUsage.set(projectId, fresh);
  return fresh;
}

/**
 * Assistant API message usage → tokens currently occupying the context window
 * (prompt tokens incl. cache + this response's output).
 */
export function recordAssistantUsage(
  projectId: string,
  usage: unknown,
  model?: unknown,
): void {
  if (!usage || typeof usage !== 'object') return;
  const u = usage as Record<string, unknown>;
  const used =
    asNumber(u.input_tokens) +
    asNumber(u.cache_read_input_tokens) +
    asNumber(u.cache_creation_input_tokens) +
    asNumber(u.output_tokens);
  if (used <= 0) return;
  const state = getState(projectId);
  const next: ProjectUsageState = {
    ...state,
    contextUsedTokens: used,
    ...(typeof model === 'string' && model ? { model } : {}),
    updatedAt: nowIso(),
  };
  projectUsage.set(projectId, next);
  // No publish here — assistant messages are frequent; the result event publishes.
}

/**
 * Final `result` message of a turn → per-turn usage/cost, context window size,
 * cumulative totals. Persists and publishes the snapshot.
 */
export async function recordTurnResult(projectId: string, resultMessage: unknown): Promise<void> {
  if (!resultMessage || typeof resultMessage !== 'object') return;
  const msg = resultMessage as Record<string, unknown>;
  const usage = (msg.usage ?? {}) as Record<string, unknown>;
  const modelUsage = (msg.modelUsage ?? {}) as Record<string, Record<string, unknown>>;

  const state = getState(projectId);

  // Context window: prefer the entry for the model we saw on assistant
  // messages; otherwise the largest reported window (subagents may add rows).
  let contextWindow = state.contextWindow;
  let model = state.model;
  const entries = Object.entries(modelUsage).filter(
    ([, v]) => v && typeof v === 'object',
  );
  const preferred = model ? entries.find(([name]) => name === model) : undefined;
  const pick =
    preferred ??
    entries.sort((a, b) => asNumber(b[1].contextWindow) - asNumber(a[1].contextWindow))[0];
  if (pick) {
    model = model ?? pick[0];
    const window = asNumber(pick[1].contextWindow);
    if (window > 0) contextWindow = window;
  }

  const lastTurn: AgentTurnUsage = {
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadInputTokens: asNumber(usage.cache_read_input_tokens),
    cacheCreationInputTokens: asNumber(usage.cache_creation_input_tokens),
    costUsd: asNumber(msg.total_cost_usd) || undefined,
    durationMs: asNumber(msg.duration_ms) || undefined,
    numTurns: asNumber(msg.num_turns) || undefined,
  };

  const totals: AgentUsageTotals = {
    ...state.totals,
    turns: state.totals.turns + 1,
    totalInputTokens:
      state.totals.totalInputTokens +
      lastTurn.inputTokens +
      lastTurn.cacheReadInputTokens +
      lastTurn.cacheCreationInputTokens,
    totalOutputTokens: state.totals.totalOutputTokens + lastTurn.outputTokens,
    totalCostUsd:
      Math.round((state.totals.totalCostUsd + (lastTurn.costUsd ?? 0)) * 10_000) / 10_000,
  };

  const next: ProjectUsageState = {
    model,
    contextWindow,
    contextUsedTokens: state.contextUsedTokens,
    lastTurn,
    totals,
    updatedAt: nowIso(),
  };
  projectUsage.set(projectId, next);
  publishSnapshot(projectId, next);
  await persistState(projectId, next);
}

/** SDK `rate_limit_event` → account-wide window utilization. Publishes to the project stream. */
export function recordRateLimit(projectId: string, info: unknown): void {
  if (!info || typeof info !== 'object') return;
  const i = info as Record<string, unknown>;
  const type = typeof i.rateLimitType === 'string' ? i.rateLimitType : undefined;
  const window = {
    utilization: typeof i.utilization === 'number' ? i.utilization : undefined,
    resetsAt:
      typeof i.resetsAt === 'number' && i.resetsAt > 0
        ? new Date(i.resetsAt * 1000).toISOString()
        : undefined,
    status: typeof i.status === 'string' ? i.status : undefined,
  };
  if (type === 'five_hour') {
    globalRateLimits = { ...globalRateLimits, fiveHour: window, updatedAt: nowIso() };
  } else if (type === 'seven_day' || type === 'seven_day_opus' || type === 'seven_day_sonnet') {
    globalRateLimits = { ...globalRateLimits, sevenDay: window, updatedAt: nowIso() };
  } else {
    return; // overage/unknown — not surfaced in the panel
  }
  publishSnapshot(projectId, getState(projectId));
}

/**
 * The account behind a run answered "You've hit your limit …" — the CLI's
 * stream-json (containerized path) carries no rate_limit_event, so peg the
 * 5-hour meter from the reply itself. Publishes so the chips flip red at once.
 */
export function markRateLimitExhausted(projectId: string, resetsAtIso?: string): void {
  globalRateLimits = {
    ...globalRateLimits,
    fiveHour: { utilization: 1, status: 'rejected', ...(resetsAtIso ? { resetsAt: resetsAtIso } : {}) },
    updatedAt: nowIso(),
  };
  publishSnapshot(projectId, getState(projectId));
}

/** /clear: fresh context + fresh totals. Publishes and persists the reset snapshot. */
export async function resetProjectUsage(projectId: string): Promise<void> {
  const state = getState(projectId);
  const next: ProjectUsageState = {
    model: state.model,
    contextWindow: state.contextWindow,
    contextUsedTokens: 0,
    lastTurn: undefined,
    totals: emptyTotals(),
    updatedAt: nowIso(),
  };
  projectUsage.set(projectId, next);
  publishSnapshot(projectId, next);
  await persistState(projectId, next);
}

/** Current snapshot for the status endpoint (falls back to the persisted copy after a restart). */
export async function getAgentUsageSnapshot(projectId: string): Promise<AgentUsageSnapshot> {
  let state = projectUsage.get(projectId);
  if (!state) {
    const persisted = await loadPersistedState(projectId);
    if (persisted) {
      projectUsage.set(projectId, persisted);
      state = persisted;
    }
  }
  return buildSnapshot(projectId, state ?? { totals: emptyTotals(), updatedAt: nowIso() });
}
