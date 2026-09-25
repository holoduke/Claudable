'use client';

/**
 * Credits meter above the chat input for projects of a CUSTOMER organisation
 * (they run on their own metered Anthropic key within a monthly budget).
 * Renders nothing for internal projects. Refreshes every minute and whenever the
 * agent status changes (a finished run has just been booked).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/contexts/I18nContext';
import { DATE_LOCALE } from '@/lib/i18n/config';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';
const REFRESH_MS = 60_000;

interface Credits {
  enabled: boolean;
  budgetCents?: number | null;
  spentCents?: number;
  remainingCents?: number | null;
  exhausted?: boolean;
  resetsAt?: string;
}

interface Props {
  projectId: string;
  /** Any value that changes when a run finishes (e.g. the agent status timestamp). */
  refreshKey?: unknown;
}

const euro = (cents: number, locale: string) =>
  (cents / 100).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function CreditsMeter({ projectId, refreshKey }: Props) {
  const { t, locale } = useI18n();
  const [credits, setCredits] = useState<Credits | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/credits`);
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success) setCredits(json.data as Credits);
    } catch {
      /* the meter is informative; keep the last value */
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, refreshKey]);

  if (!credits?.enabled) return null;

  const dateLocale = DATE_LOCALE[locale];
  const spent = credits.spentCents ?? 0;
  const budget = credits.budgetCents ?? null;
  const resetDate = credits.resetsAt
    ? new Date(credits.resetsAt).toLocaleDateString(dateLocale, { day: 'numeric', month: 'long', timeZone: 'UTC' })
    : '';
  const pct = budget ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  const tone = credits.exhausted ? 'bg-red-500' : pct >= 90 ? 'bg-amber-500' : 'bg-brand-500';

  if (credits.exhausted) {
    return (
      <div role="status" className="mb-2 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
        {t('credits.exhausted', { date: resetDate })}
      </div>
    );
  }

  return (
    <div className="mb-2 flex items-center gap-3 px-1 text-xs text-gray-500 dark:text-gray-400" title={t('credits.estimateNote')}>
      <span className="font-medium text-gray-700 dark:text-gray-200">{t('credits.title')}</span>
      {budget !== null ? (
        <>
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-gray-200 dark:bg-white/10" aria-hidden>
            <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
          </div>
          <span>{t('credits.meter', { spent: euro(spent, dateLocale), budget: euro(budget, dateLocale) })}</span>
          {pct >= 90 && <span className="text-amber-600 dark:text-amber-400">· {t('credits.low')}</span>}
        </>
      ) : (
        <span>{t('credits.meterUnlimited', { spent: euro(spent, dateLocale) })}</span>
      )}
      {resetDate && <span className="ml-auto">{t('credits.resets', { date: resetDate })}</span>}
    </div>
  );
}
