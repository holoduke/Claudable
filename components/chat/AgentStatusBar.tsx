'use client';

/**
 * Compact agent-status strip above the chat input: context occupancy plus the
 * subscription 5-hour / weekly windows, with a click-to-open details popover
 * (last-turn tokens & cost, cumulative totals, reset times, command hints).
 *
 * Data: initial GET /api/chat/:id/agent-status (re-fetched each time the
 * popover opens — the server merges real utilization from the OAuth usage
 * endpoint there), then live `agent_status` SSE events forwarded by the
 * parent. When no percentage is available, the window meters fall back to the
 * event-reported status (OK / limit reached) instead of a bare “no data”.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRateLimitWindow, AgentUsageSnapshot } from '@/types/agent-usage';
import { useI18n } from '@/contexts/I18nContext';

type TFunc = ReturnType<typeof useI18n>['t'];

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

const formatReset = (t: TFunc, iso?: string): string | null => {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return null;
  const diffMin = Math.round((target - Date.now()) / 60_000);
  if (diffMin <= 0) return t('chat.status.resetsSoon');
  if (diffMin < 60) return t('chat.status.resetsInMinutes', { minutes: diffMin });
  const hours = Math.floor(diffMin / 60);
  if (hours < 48) return t('chat.status.resetsInHours', { hours, minutes: diffMin % 60 });
  return t('chat.status.resetsInDays', { days: Math.round(hours / 24) });
};

const windowTitle = (t: TFunc, label: string, pct: number | undefined, resetsAt?: string): string => {
  const reset = resetsAt && Date.parse(resetsAt) > Date.now() ? ` · ${formatReset(t, resetsAt)}` : '';
  return pct === undefined
    ? t('chat.status.windowUnknown', { label })
    : `${t('chat.status.windowUsed', { label, pct })}${reset}`;
};

const formatAgo = (t: TFunc, iso: string): string => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min) || min < 1) return t('chat.status.justNow');
  if (min < 60) return t('chat.status.minutesAgo', { count: min });
  const h = Math.floor(min / 60);
  return h < 48 ? t('chat.status.hoursAgo', { count: h }) : t('chat.status.daysAgo', { count: Math.round(h / 24) });
};

const pctOfWindow = (w?: AgentRateLimitWindow): number | undefined => {
  if (!w || typeof w.utilization !== 'number') return undefined;
  // Past its reset the stored number is stale (the account may have been used
  // elsewhere since) — show "unknown" until the next agent turn refreshes it.
  if (w.resetsAt && Date.parse(w.resetsAt) < Date.now()) return undefined;
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

function Meter({
  label,
  pct,
  sub,
  status,
}: {
  label: string;
  pct?: number;
  sub?: string | null;
  /** Window status when no percentage is available (rate-limit meters only). */
  status?: string;
}) {
  const { t } = useI18n();
  // No percentage → fall back to the reported status so the meter still says
  // something useful ('no data yet' only when nothing was reported at all).
  const rejected = status === 'rejected';
  const effectivePct = pct ?? (rejected ? 100 : undefined);
  const valueText =
    pct !== undefined
      ? `${pct}%`
      : rejected
      ? t('chat.status.limitReached')
      : status
      ? t('chat.status.ok')
      : t('chat.status.noData');
  const valueColor =
    pct !== undefined
      ? textColor(pct)
      : rejected
      ? 'text-red-500'
      : status
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-gray-400 dark:text-gray-500';
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-gray-600 dark:text-gray-300">{label}</span>
        <span className={valueColor}>{valueText}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-gray-100 dark:bg-white/8 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${meterColor(effectivePct)}`}
          style={{ width: `${effectivePct ?? 0}%` }}
        />
      </div>
      {sub && <div className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">{sub}</div>}
    </div>
  );
}

export default function AgentStatusBar({ projectId, liveStatus, open, onOpenChange }: AgentStatusBarProps) {
  const { t } = useI18n();
  const [fetched, setFetched] = useState<AgentUsageSnapshot | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hasFetchedRef = useRef(false);

  // Initial load, then a refresh every time the popover opens — the server
  // merges fresh utilization from the OAuth usage endpoint on this request.
  useEffect(() => {
    if (!projectId) return;
    if (!open && hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    const controller = new AbortController();
    fetch(`${API_BASE}/api/chat/${projectId}/agent-status`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!controller.signal.aborted && j?.success && j.data) setFetched(j.data as AgentUsageSnapshot);
      })
      .catch(() => { /* aborted or offline: keep the previous snapshot */ });
    return () => controller.abort();
  }, [projectId, open]);

  // Live SSE snapshots supersede the initial fetch — except the rate-limit
  // block, where whichever side carries the newer API refresh wins (an SSE
  // snapshot published mid-run would otherwise shadow a fresher popover fetch).
  const status = useMemo(() => {
    if (!liveStatus) return fetched;
    if (!fetched) return liveStatus;
    const liveAt = Date.parse(liveStatus.rateLimits?.updatedAt ?? '') || 0;
    const fetchedAt = Date.parse(fetched.rateLimits?.updatedAt ?? '') || 0;
    return fetchedAt > liveAt
      ? { ...liveStatus, rateLimits: fetched.rateLimits }
      : liveStatus;
  }, [liveStatus, fetched]);

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
  const limitsApplicable = status?.limitsApplicable === true;
  const fiveHourPct = pctOfWindow(status?.rateLimits?.fiveHour);
  const weekPct = pctOfWindow(status?.rateLimits?.sevenDay);

  const chips = useMemo(() => {
    const parts: { key: string; label: string; pct?: number; title?: string }[] = [
      { key: 'ctx', label: t('chat.status.chipContext'), pct: contextPct },
    ];
    // The plan windows are always shown for projects on the platform account
    // ("–" until the first agent turn reports them).
    if (limitsApplicable) {
      parts.push({ key: '5h', label: t('chat.status.chipFiveHour'), pct: fiveHourPct, title: windowTitle(t, t('chat.status.fiveHourLimit'), fiveHourPct, status?.rateLimits?.fiveHour?.resetsAt) });
      parts.push({ key: 'wk', label: t('chat.status.chipWeek'), pct: weekPct, title: windowTitle(t, t('chat.status.weeklyLimit'), weekPct, status?.rateLimits?.sevenDay?.resetsAt) });
    }
    return parts;
  }, [contextPct, fiveHourPct, weekPct, limitsApplicable, status?.rateLimits, t]);

  const hasData = !!status && (status.contextUsedTokens !== undefined || !!status.totals?.turns || !!status.rateLimits);

  // Nothing recorded for this project: still show the strip on the platform
  // account (the account windows are what the team wants to see at all times);
  // otherwise stay invisible unless /usage asked for it.
  if (!hasData && !limitsApplicable) {
    if (!open) return null;
    return (
      <div className="relative flex justify-end mb-1.5" ref={panelRef}>
        <div role="dialog" aria-label={t('chat.status.title')} className="absolute bottom-full right-0 mb-2 w-80 z-120 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl p-4 text-left">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-50 mb-1">{t('chat.status.title')}</div>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('chat.status.noUsage')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex justify-end mb-1.5" ref={panelRef}>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        title={t('chat.status.buttonTitle')}
        aria-label={t('chat.status.buttonTitle')}
        aria-expanded={open}
        className="flex items-center gap-2 px-2 py-1 rounded-md text-[11px] text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/6 transition-colors"
      >
        {chips.map((c) => (
          <span key={c.key} className="flex items-center gap-1" title={c.title}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${meterColor(c.pct)}`} />
            <span>{c.label}</span>
            <span className={textColor(c.pct)}>{c.pct === undefined ? '–' : `${c.pct}%`}</span>
          </span>
        ))}
      </button>

      {open && status && (
        <div role="dialog" aria-label={t('chat.status.title')} className="absolute bottom-full right-0 mb-2 w-80 z-120 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl p-4 space-y-4 text-left">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-50">{t('chat.status.title')}</span>
            {status.model && (
              <span className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded-sm">
                {status.model.replace(/^claude-/, '')}
              </span>
            )}
          </div>

          <Meter
            label={t('chat.status.contextWindow')}
            pct={contextPct}
            sub={
              status.contextUsedTokens !== undefined
                ? t('chat.status.contextSub', { used: formatTokens(status.contextUsedTokens), total: formatTokens(status.contextWindow) })
                : null
            }
          />
          <Meter
            label={t('chat.status.fiveHourLimit')}
            pct={fiveHourPct}
            status={status.rateLimits?.fiveHour?.status}
            sub={formatReset(t, status.rateLimits?.fiveHour?.resetsAt)}
          />
          <Meter
            label={t('chat.status.weeklyLimit')}
            pct={weekPct}
            status={status.rateLimits?.sevenDay?.status}
            sub={formatReset(t, status.rateLimits?.sevenDay?.resetsAt)}
          />
          {limitsApplicable && (
            <p className="-mt-2 text-[10px] text-gray-400 dark:text-gray-500">
              {status.rateLimits?.updatedAt
                ? t('chat.status.subscriptionUpdated', { ago: formatAgo(t, status.rateLimits.updatedAt) })
                : t('chat.status.subscriptionPending')}
            </p>
          )}

          {status.lastTurn && (
            <div className="text-xs text-gray-600 dark:text-gray-300 space-y-1">
              <div className="font-medium text-gray-700 dark:text-gray-200">{t('chat.status.lastTurn')}</div>
              <div className="flex justify-between text-gray-500 dark:text-gray-400">
                <span>
                  {t('chat.status.tokensInOut', {
                    input: formatTokens(
                      status.lastTurn.inputTokens +
                      status.lastTurn.cacheReadInputTokens +
                      status.lastTurn.cacheCreationInputTokens,
                    ),
                    output: formatTokens(status.lastTurn.outputTokens),
                  })}
                </span>
                <span>{formatCost(status.lastTurn.costUsd)}</span>
              </div>
            </div>
          )}

          {status.totals && status.totals.turns > 0 && (
            <div className="text-xs text-gray-600 dark:text-gray-300 space-y-1">
              <div className="font-medium text-gray-700 dark:text-gray-200">
                {status.totals.turns === 1
                  ? t('chat.status.projectTurnsOne')
                  : t('chat.status.projectTurnsOther', { count: status.totals.turns })}
              </div>
              <div className="flex justify-between text-gray-500 dark:text-gray-400">
                <span>
                  {t('chat.status.tokensInOut', {
                    input: formatTokens(status.totals.totalInputTokens),
                    output: formatTokens(status.totals.totalOutputTokens),
                  })}
                </span>
                <span>{formatCost(status.totals.totalCostUsd)}</span>
              </div>
            </div>
          )}

          <div className="pt-2 border-t border-gray-100 dark:border-gray-800 text-[10px] text-gray-400 dark:text-gray-500">
            {t('chat.status.commandsHint')}
          </div>
        </div>
      )}
    </div>
  );
}
