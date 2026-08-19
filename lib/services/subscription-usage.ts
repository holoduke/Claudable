/**
 * Real subscription window utilization from the OAuth usage endpoint — the
 * same data the Claude CLI's /usage screen shows. The CLI's stream-json
 * `rate_limit_event` stopped carrying a `utilization` field (only status +
 * resetsAt remain), so this endpoint is the only source of true percentages
 * for the 5-hour / weekly meters.
 *
 * Fetches are cached per-token for a short TTL: the panel polls on open and
 * every project page load, and the numbers only move while runs are burning
 * tokens.
 */
import { createHash } from 'crypto';
import type { AgentRateLimits, AgentRateLimitWindow } from '@/types/agent-usage';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

interface CacheEntry {
  at: number;
  limits: AgentRateLimits | null;
}

const cache = new Map<string, CacheEntry>();

function windowFrom(raw: unknown): AgentRateLimitWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  // The endpoint reports utilization as 0..100; internal snapshots use the
  // SDK's historical 0..1 fraction, so normalize here.
  const utilization =
    typeof r.utilization === 'number' && Number.isFinite(r.utilization)
      ? Math.max(0, Math.min(1, r.utilization / 100))
      : undefined;
  const resetsAt =
    typeof r.resets_at === 'string' && r.resets_at ? r.resets_at : undefined;
  if (utilization === undefined && !resetsAt) return undefined;
  return { utilization, resetsAt };
}

/** Pure mapping of the endpoint's JSON body → AgentRateLimits (exported for tests). */
export function mapUsageResponse(body: unknown): AgentRateLimits | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const limits: AgentRateLimits = {};
  const fiveHour = windowFrom(b.five_hour);
  if (fiveHour) limits.fiveHour = fiveHour;
  const sevenDay = windowFrom(b.seven_day);
  if (sevenDay) limits.sevenDay = sevenDay;
  if (!limits.fiveHour && !limits.sevenDay) return null;
  return { ...limits, updatedAt: new Date().toISOString() };
}

/**
 * Fetch the account's window utilization for the given OAuth access token.
 * Returns null on any failure (expired token, network, unexpected shape) —
 * callers fall back to the event-derived state. Negative results are cached
 * too, so a broken token can't hammer the endpoint.
 */
export async function fetchSubscriptionUsage(token: string): Promise<AgentRateLimits | null> {
  const key = createHash('sha256').update(token).digest('hex');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.limits;

  let limits: AgentRateLimits | null = null;
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      limits = mapUsageResponse(await res.json().catch(() => null));
    } else {
      console.warn(`[SubscriptionUsage] usage endpoint returned ${res.status}`);
    }
  } catch (error) {
    console.warn('[SubscriptionUsage] fetch failed:', error instanceof Error ? error.message : error);
  }

  cache.set(key, { at: Date.now(), limits });
  return limits;
}
