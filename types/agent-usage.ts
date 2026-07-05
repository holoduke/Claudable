/**
 * Agent usage snapshot shared by server (capture) and client (status panel).
 *
 * Populated from the Agent SDK / CLI stream:
 *  - assistant messages → tokens currently in the context window
 *  - the final `result` message → per-turn tokens/cost + the model's context window
 *  - `rate_limit_event` messages → subscription 5-hour / weekly window utilization
 */

export interface AgentRateLimitWindow {
  /** 0..1 fraction of the window consumed (SDK `utilization`). */
  utilization?: number;
  /** ISO timestamp when the window resets. */
  resetsAt?: string;
  status?: 'allowed' | 'allowed_warning' | 'rejected' | string;
}

export interface AgentRateLimits {
  fiveHour?: AgentRateLimitWindow;
  sevenDay?: AgentRateLimitWindow;
  updatedAt?: string;
}

export interface AgentTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

export interface AgentUsageTotals {
  /** Agent turns since tracking started (or since the last /clear). */
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  since?: string;
}

export interface AgentUsageSnapshot {
  projectId: string;
  updatedAt: string;
  model?: string;
  /** The model's total context window, in tokens (from the SDK's ModelUsage). */
  contextWindow?: number;
  /** Tokens occupying the context after the last agent response. */
  contextUsedTokens?: number;
  /** 0..100, derived from the two fields above. */
  contextPct?: number;
  lastTurn?: AgentTurnUsage;
  totals?: AgentUsageTotals;
  /** Account-wide subscription limits (not per project). */
  rateLimits?: AgentRateLimits;
}
