'use client';

/**
 * Compact agent-status strip above the chat input: context occupancy plus the
 * subscription 5-hour / weekly windows, with a click-to-open details popover
 * (last-turn tokens & cost, cumulative totals, reset times, command hints).
 *
 * Data: initial GET /api/chat/:id/agent-status, then live `agent_status` SSE
 * events forwarded by the parent. Rate-limit windows only exist after the
 * agent has run once (the SDK reports them per turn) — shown as “–” until then.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRateLimitWindow, AgentUsageSnapshot } from '@/types/agent-usage';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';

interface AgentStatusBarProps {
  projectId: string;
  /** Live snapshot pushed over SSE (parent forwards `agent_status` events). */
  liveStatus?: AgentUsageSnapshot | null;
  /** Lets the page open the popover from the /usage command. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const formatTokens = (n?: number): string => {
  if (n === undefined || !Number.isFinite(n)) return '–';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
};

const formatCost = (n?: number): string =>
  n === undefined || !Number.isFinite(n) ? '–' : `$${n.toFixed(n >= 1 ? 2 : 3)}`;

const formatReset = (iso?: string): string | null => {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return null;
  const diffMin = Math.round((target - Date.now()) / 60_000);
  if (diffMin <= 0) return 'resets soon';
  if (diffMin < 60) return `resets in ${diffMin}m`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 48) return `resets in ${hours}h ${diffMin % 60}m`;
  return `resets in ${Math.round(hours / 24)}d`;
};

const pctOfWindow = (w?: AgentRateLimitWindow): number | undefined => {
  if (!w || typeof w.utilization !== 'number') return undefined;
  // The SDK reports utilization as 0..1; clamp defensively.
  const pct = w.utilization <= 1 ? w.utilization * 100 : w.utilization;
  return Math.max(0, Math.min(100, Math.round(pct)));
};

const meterColor = (pct?: number): string => {
  if (pct === undefined) return 'bg-gray-300 dark:bg-gray-600';
  if (pct >= 90) return 'bg-red-500';
  if (pct >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
};

const textColor = (pct?: number): string => {
  if (pct === undefined) return 'text-gray-400 dark:text-gray-500';
  if (pct >= 90) return 'text-red-500';
  if (pct >= 70) return 'text-amber-500';
  return 'text-gray-500 dark:text-gray-400';
};

function Meter({ label, pct, sub }: { label: string; pct?: number; sub?: string | null }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-gray-600 dark:text-gray-300">{label}</span>
        <span className={textColor(pct)}>{pct === undefined ? 'not reported yet' : `${pct}%`}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-gray-100 dark:bg-white/[0.08] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${meterColor(pct)}`}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
      {sub && <div className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">{sub}</div>}
    </div>
  );
}

export default function AgentStatusBar({ projectId, liveStatus, open, onOpenChange }: AgentStatusBarProps) {
  const [fetched, setFetched] = useState<AgentUsageSnapshot | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/chat/${projectId}/agent-status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j?.success && j.data) setFetched(j.data as AgentUsageSnapshot);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  // Live SSE snapshots supersede the initial fetch.
  const status = liveStatus ?? fetched;

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  const contextPct = status?.contextPct !== undefined ? Math.round(status.contextPct) : undefined;
  const fiveHourPct = pctOfWindow(status?.rateLimits?.fiveHour);
  const weekPct = pctOfWindow(status?.rateLimits?.sevenDay);

  const chips = useMemo(() => {
    const parts: { key: string; label: string; pct?: number }[] = [
      { key: 'ctx', label: 'Context', pct: contextPct },
    ];
    if (fiveHourPct !== undefined) parts.push({ key: '5h', label: '5h', pct: fiveHourPct });
    if (weekPct !== undefined) parts.push({ key: 'wk', label: 'Week', pct: weekPct });
    return parts;
  }, [contextPct, fiveHourPct, weekPct]);

  // Nothing recorded yet and nothing to show — stay invisible until the agent runs.
  if (!status || (status.contextUsedTokens === undefined && !status.totals?.turns)) {
    return null;
  }

  return (
    <div className="relative flex justify-end mb-1.5" ref={panelRef}>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        title="Agent status — context & usage limits (/usage)"
        className="flex items-center gap-2 px-2 py-1 rounded-md text-[11px] text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors"
      >
        {chips.map((c) => (
          <span key={c.key} className="flex items-center gap-1">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${meterColor(c.pct)}`} />
            <span>{c.label}</span>
            <span className={textColor(c.pct)}>{c.pct === undefined ? '–' : `${c.pct}%`}</span>
          </span>
        ))}
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-80 z-[120] rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl p-4 space-y-4 text-left">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-50">Agent status</span>
            {status.model && (
              <span className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
                {status.model.replace(/^claude-/, '')}
              </span>
            )}
          </div>

          <Meter
            label="Context window"
            pct={contextPct}
            sub={
              status.contextUsedTokens !== undefined
                ? `${formatTokens(status.contextUsedTokens)} of ${formatTokens(status.contextWindow)} tokens — /compact frees space, /clear starts fresh`
                : null
            }
          />
          <Meter label="5-hour limit" pct={fiveHourPct} sub={formatReset(status.rateLimits?.fiveHour?.resetsAt)} />
          <Meter label="Weekly limit" pct={weekPct} sub={formatReset(status.rateLimits?.sevenDay?.resetsAt)} />

          {status.lastTurn && (
            <div className="text-xs text-gray-600 dark:text-gray-300 space-y-1">
              <div className="font-medium text-gray-700 dark:text-gray-200">Last turn</div>
              <div className="flex justify-between text-gray-500 dark:text-gray-400">
                <span>
                  ↑ {formatTokens(
                    status.lastTurn.inputTokens +
                    status.lastTurn.cacheReadInputTokens +
                    status.lastTurn.cacheCreationInputTokens,
                  )} in · ↓ {formatTokens(status.lastTurn.outputTokens)} out
                </span>
                <span>{formatCost(status.lastTurn.costUsd)}</span>
              </div>
            </div>
          )}

          {status.totals && status.totals.turns > 0 && (
            <div className="text-xs text-gray-600 dark:text-gray-300 space-y-1">
              <div className="font-medium text-gray-700 dark:text-gray-200">
                This project · {status.totals.turns} turn{status.totals.turns === 1 ? '' : 's'}
              </div>
              <div className="flex justify-between text-gray-500 dark:text-gray-400">
                <span>
                  ↑ {formatTokens(status.totals.totalInputTokens)} in · ↓ {formatTokens(status.totals.totalOutputTokens)} out
                </span>
                <span>{formatCost(status.totals.totalCostUsd)}</span>
              </div>
            </div>
          )}

          <div className="pt-2 border-t border-gray-100 dark:border-gray-800 text-[10px] text-gray-400 dark:text-gray-500">
            Type / in the chat for commands: /clear · /compact · /usage · /help
          </div>
        </div>
      )}
    </div>
  );
}
