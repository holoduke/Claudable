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
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { prisma } from '@/lib/db/client';
import { isCustomerProject } from '@/lib/services/tenant-policy';
import { streamManager } from './stream';
import type {
  AgentRateLimits,
  AgentRateLimitWindow,
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

// The account windows survive restarts (every deploy used to blank them until
// the next turn): a small JSON file next to the data dir. Loaded once, written
// on change. Best-effort — a read/write failure only means "no numbers yet".
const RATE_LIMITS_FILE = path.join(
  path.resolve(process.env.PROJECTS_DIR && path.isAbsolute(process.env.PROJECTS_DIR) ? process.env.PROJECTS_DIR : path.resolve(process.cwd(), process.env.PROJECTS_DIR || './data/projects'), '..'),
  '.claude-rate-limits.json',
);
function loadRateLimits(): AgentRateLimits {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(RATE_LIMITS_FILE, 'utf8')) as AgentRateLimits;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
function saveRateLimits(limits: AgentRateLimits): void {
  const tmp = `${RATE_LIMITS_FILE}.tmp`;
  fs.writeFile(tmp, JSON.stringify(limits))
    .then(() => fs.rename(tmp, RATE_LIMITS_FILE))
    .catch(() => { /* best-effort */ });
}
let globalRateLimits: AgentRateLimits = loadRateLimits();

/*
 * `globalRateLimits` describes New Story's Claude SUBSCRIPTION account. Customer
 * projects run on their own API key, so they must neither see those windows nor
 * move them. Membership is cached per project (looked up once, async); until it
 * is known the windows are hidden — failing closed.
 */
const TENANT_CACHE_MS = 5 * 60 * 1000; // a project can move between orgs
const customerProjectCache = new Map<string, { isCustomer: boolean; at: number }>();
function rememberTenant(projectId: string): void {
  const hit = customerProjectCache.get(projectId);
  if (hit && Date.now() - hit.at < TENANT_CACHE_MS) return;
  isCustomerProject(projectId)
    .then((isCustomer) => customerProjectCache.set(projectId, { isCustomer, at: Date.now() }))
    .catch(() => { /* stays unknown/stale → re-checked next time */ });
}
function sharesPlatformAccount(projectId: string): boolean {
  rememberTenant(projectId);
  return customerProjectCache.get(projectId)?.isCustomer === false;
}
/**
 * Awaited variant: resolves the tenant when it isn't cached yet. The sync check
 * above fails closed on a cold cache, which dropped the rate-limit event of a
 * brand-new project's first turn and hid the strip on its first page load.
 */
async function sharesPlatformAccountAsync(projectId: string): Promise<boolean> {
  const hit = customerProjectCache.get(projectId);
  if (hit && Date.now() - hit.at < TENANT_CACHE_MS) return hit.isCustomer === false;
  try {
    const isCustomer = await isCustomerProject(projectId);
    customerProjectCache.set(projectId, { isCustomer, at: Date.now() });
    return !isCustomer;
  } catch {
    return false; // unknown → fail closed
  }
}

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
    rateLimits:
      sharesPlatformAccount(projectId) && Object.keys(globalRateLimits).length > 0 ? globalRateLimits : undefined,
    // Whether this project runs on (and may see) the platform subscription's windows.
    limitsApplicable: sharesPlatformAccount(projectId),
  };
}

function publishSnapshot(projectId: string, state: ProjectUsageState): void {
  streamManager.publish(projectId, {
    type: 'agent_status',
    data: buildSnapshot(projectId, state),
  });
}

/**
 * Persist the per-project state into Project.settings.agentUsage (best-effort).
 * Single atomic json_set — a read-modify-write here raced other settings
 * writers (the containers/composition routes) and could silently drop their
 * keys when a turn ended mid-edit. json_set only touches $.agentUsage.
 */
async function persistState(projectId: string, state: ProjectUsageState): Promise<void> {
  try {
    const payload = JSON.stringify(state);
    await prisma.$executeRaw`
      UPDATE projects SET settings =
        CASE
          WHEN settings IS NULL OR json_valid(settings) = 0
            THEN json_object('agentUsage', json(${payload}))
          ELSE json_set(settings, '$.agentUsage', json(${payload}))
        END
      WHERE id = ${projectId}`;
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

  // Cold start (fresh process): hydrate cumulative totals from the persisted
  // copy BEFORE the first write — otherwise the first turn after a redeploy
  // overwrites the stored totals with turns:1. The sync record paths may have
  // already seeded a shell entry with live context/model; keep those fields.
  let state = getState(projectId);
  if (state.totals.turns === 0 && !state.lastTurn) {
    const persisted = await loadPersistedState(projectId);
    if (persisted) {
      state = {
        ...persisted,
        contextUsedTokens: state.contextUsedTokens ?? persisted.contextUsedTokens,
        model: state.model ?? persisted.model,
      };
      projectUsage.set(projectId, state);
    }
  }

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

/**
 * Merge utilization fetched from the OAuth usage endpoint (the CLI stream no
 * longer reports percentages). API values win over event-derived ones — they
 * carry the real numbers — but an event-pegged `rejected` status is kept until
 * the API confirms the window recovered.
 */
export function mergeApiRateLimits(limits: AgentRateLimits): void {
  const mergeWindow = (
    existing: AgentRateLimitWindow | undefined,
    incoming: AgentRateLimitWindow | undefined,
  ): AgentRateLimitWindow | undefined => {
    if (!incoming) return existing;
    const merged = { ...existing, ...incoming };
    // An event-pegged 'rejected' is stale once the API reports the window
    // back under its cap (the API itself never reports a status).
    if (
      merged.status === 'rejected' &&
      typeof incoming.utilization === 'number' &&
      incoming.utilization < 1
    ) {
      merged.status = 'allowed';
    }
    return merged;
  };
  globalRateLimits = {
    ...globalRateLimits,
    fiveHour: mergeWindow(globalRateLimits.fiveHour, limits.fiveHour),
    sevenDay: mergeWindow(globalRateLimits.sevenDay, limits.sevenDay),
    updatedAt: limits.updatedAt ?? nowIso(),
  };
  saveRateLimits(globalRateLimits);
}

const isoFromEpoch = (v: unknown): string | undefined =>
  typeof v === 'number' && v > 0 ? new Date(v * 1000).toISOString() : undefined;
// Window fraction 0..1. The CLI reports fractions; tolerate a 0..100 percent.
const fraction = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(1, v > 1 ? v / 100 : v) : undefined;

/**
 * A `rate_limit_event` → the account's 5-hour / weekly windows (pure; exported
 * for tests). Current CLIs put the real numbers for BOTH windows in
 * `unifiedWindows` on every turn; the top-level fields describe only the window
 * named in `rateLimitType` (status + reset; `utilization` is mostly absent).
 */
export function rateLimitsFromEvent(info: unknown, prev: AgentRateLimits): AgentRateLimits | null {
  if (!info || typeof info !== 'object') return null;
  const i = info as Record<string, unknown>;
  const type = typeof i.rateLimitType === 'string' ? i.rateLimitType : undefined;
  const status = typeof i.status === 'string' ? i.status : undefined;
  const next: AgentRateLimits = { ...prev };
  let changed = false;

  const unified = i.unifiedWindows && typeof i.unifiedWindows === 'object' ? i.unifiedWindows as Record<string, unknown> : null;
  for (const [key, field] of [['five_hour', 'fiveHour'], ['seven_day', 'sevenDay']] as const) {
    const w = unified?.[key];
    if (!w || typeof w !== 'object') continue;
    const r = w as Record<string, unknown>;
    const utilization = fraction(r.utilization);
    const resetsAt = isoFromEpoch(r.resetsAt);
    if (utilization === undefined && !resetsAt) continue;
    next[field] = {
      ...next[field],
      ...(utilization !== undefined ? { utilization } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      // A stale 'rejected' clears once the window is back under its cap.
      status: next[field]?.status === 'rejected' && utilization !== undefined && utilization < 1 ? 'allowed' : next[field]?.status,
    };
    changed = true;
  }

  const field = type === 'five_hour' ? 'fiveHour'
    : type === 'seven_day' || type === 'seven_day_opus' || type === 'seven_day_sonnet' ? 'sevenDay'
    : null;
  if (field) {
    const utilization = fraction(i.utilization);
    const resetsAt = isoFromEpoch(i.resetsAt);
    next[field] = {
      ...next[field],
      ...(utilization !== undefined ? { utilization } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      ...(status ? { status } : {}),
    };
    changed = true;
  }
  if (!changed) return null; // overage-only / unknown — not surfaced
  return { ...next, updatedAt: nowIso() };
}

/** SDK `rate_limit_event` → account-wide window utilization. Publishes to the project stream. */
export async function recordRateLimit(projectId: string, info: unknown): Promise<void> {
  if (!(await sharesPlatformAccountAsync(projectId))) return; // a customer's own key, not our account
  const next = rateLimitsFromEvent(info, globalRateLimits);
  if (!next) return;
  globalRateLimits = next;
  saveRateLimits(globalRateLimits);
  publishSnapshot(projectId, getState(projectId));
}

/**
 * The account behind a run answered "You've hit your limit …" — the CLI's
 * stream-json (containerized path) carries no rate_limit_event, so peg the
 * 5-hour meter from the reply itself. Publishes so the chips flip red at once.
 */
export function markRateLimitExhausted(projectId: string, resetsAtIso?: string): void {
  if (!sharesPlatformAccount(projectId)) return;
  globalRateLimits = {
    ...globalRateLimits,
    fiveHour: { utilization: 1, status: 'rejected', ...(resetsAtIso ? { resetsAt: resetsAtIso } : {}) },
    updatedAt: nowIso(),
  };
  saveRateLimits(globalRateLimits);
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
  customerProjectCache.set(projectId, { isCustomer: await isCustomerProject(projectId), at: Date.now() });
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
