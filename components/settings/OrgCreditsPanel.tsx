'use client';

/**
 * Credits overview of a customer organisation: budget meter, this or the
 * previous month's usage per project and (for eigenaar/beheerder/superadmin)
 * per person. A superadmin can set the monthly budget.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/contexts/I18nContext';
import { DATE_LOCALE } from '@/lib/i18n/config';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface CreditsData {
  status: { budgetCents: number | null; spentCents: number; remainingCents: number | null; exhausted: boolean; resetsAt: string };
  usage: {
    periodStart: string;
    totalCents: number;
    runs: number;
    staffCents: number;
    byUser: Array<{ userId: string | null; name: string; email: string | null; cents: number; runs: number; staff: boolean }>;
    byProject: Array<{ projectId: string | null; name: string; cents: number; runs: number }>;
  };
  canEditBudget: boolean;
}

interface Props {
  orgId: string;
  onToast: (message: string, type: 'success' | 'error') => void;
}

const euro = (cents: number, locale: string) =>
  `€${(cents / 100).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function OrgCreditsPanel({ orgId, onToast }: Props) {
  const { t, locale } = useI18n();
  const dateLocale = DATE_LOCALE[locale];
  const [month, setMonth] = useState<0 | -1>(0);
  const [data, setData] = useState<CreditsData | null>(null);
  const [budgetInput, setBudgetInput] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/orgs/${orgId}/credits?month=${month}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) throw new Error(json?.message || t('common.actionFailed'));
      const next = json.data as CreditsData;
      setData(next);
      setBudgetInput(next.status.budgetCents === null ? '' : String(next.status.budgetCents / 100));
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('common.actionFailed'), 'error');
    }
  }, [orgId, month, onToast, t]);

  useEffect(() => { void load(); }, [load]);

  const saveBudget = async () => {
    const trimmed = budgetInput.trim().replace(',', '.');
    const value = trimmed === '' ? null : Number(trimmed);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      onToast(t('common.actionFailed'), 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/orgs/${orgId}/credits`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthlyBudgetEur: value }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) throw new Error(json?.message || t('common.actionFailed'));
      onToast(t('credits.budgetSaved'), 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('common.actionFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!data) return null;
  const { status, usage } = data;
  const pct = status.budgetCents ? Math.min(100, Math.round((status.spentCents / status.budgetCents) * 100)) : 0;
  const tone = status.exhausted ? 'bg-red-500' : pct >= 90 ? 'bg-amber-500' : 'bg-brand-500';
  const resetDate = new Date(status.resetsAt).toLocaleDateString(dateLocale, { day: 'numeric', month: 'long', timeZone: 'UTC' });

  const table = (rows: Array<{ key: string; name: string; sub?: string | null; cents: number; runs: number }>) =>
    rows.length === 0 ? (
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('credits.none')}</p>
    ) : (
      <ul className="divide-y divide-gray-100 dark:divide-white/6">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center justify-between gap-3 py-1.5 text-sm">
            <span className="min-w-0 truncate text-gray-800 dark:text-gray-100">
              {r.name}
              {r.sub && <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{r.sub}</span>}
            </span>
            <span className="shrink-0 tabular-nums text-gray-700 dark:text-gray-200">
              {euro(r.cents, dateLocale)} <span className="text-xs text-gray-500 dark:text-gray-400">· {t('credits.runs', { count: String(r.runs) })}</span>
            </span>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/8 bg-white dark:bg-white/3 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-50">{t('credits.title')}</p>
        <span className="text-xs text-gray-500 dark:text-gray-400">{t('credits.resets', { date: resetDate })}</span>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-700 dark:text-gray-200">
            {status.budgetCents !== null
              ? t('credits.meter', { spent: (status.spentCents / 100).toLocaleString(dateLocale, { minimumFractionDigits: 2 }), budget: (status.budgetCents / 100).toLocaleString(dateLocale, { minimumFractionDigits: 2 }) })
              : t('credits.meterUnlimited', { spent: (status.spentCents / 100).toLocaleString(dateLocale, { minimumFractionDigits: 2 }) })}
          </span>
          {status.budgetCents !== null && <span className="tabular-nums text-gray-500 dark:text-gray-400">{pct}%</span>}
        </div>
        {status.budgetCents !== null && (
          <div className="h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-white/10">
            <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
          </div>
        )}
        {status.exhausted && <p className="text-xs text-red-600 dark:text-red-400">{t('credits.exhausted', { date: resetDate })}</p>}
      </div>

      {data.canEditBudget && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600 dark:text-gray-300 shrink-0" htmlFor={`budget-${orgId}`}>{t('credits.budgetLabel')}</label>
          <input
            id={`budget-${orgId}`}
            inputMode="decimal"
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
            placeholder={t('credits.budgetPlaceholder')}
            className="w-28 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-50"
          />
          <button onClick={saveBudget} disabled={saving}
            className="px-3 py-1.5 text-xs font-medium bg-brand-500 hover:bg-brand-600 text-white rounded-lg transition-colors disabled:opacity-50">
            {t('common.save')}
          </button>
        </div>
      )}

      <div className="flex gap-1">
        {([0, -1] as const).map((m) => (
          <button key={m} onClick={() => setMonth(m)}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${month === m ? 'border-brand-500 text-brand-600 dark:text-brand-400 bg-brand-500/10' : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300'}`}>
            {m === 0 ? t('credits.thisMonth') : t('credits.previousMonth')}
          </button>
        ))}
        <span className="ml-auto self-center text-xs tabular-nums text-gray-600 dark:text-gray-300">
          {euro(usage.totalCents, dateLocale)} · {t('credits.runs', { count: String(usage.runs) })}
        </span>
      </div>

      {usage.staffCents > 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('credits.staff', { amount: euro(usage.staffCents, dateLocale) })}</p>
      )}

      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('credits.byProject')}</p>
        {table(usage.byProject.map((p) => ({ key: p.projectId ?? 'other', name: p.name, cents: p.cents, runs: p.runs })))}
      </div>
      {usage.byUser.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('credits.byPerson')}</p>
          {table(usage.byUser.map((u) => ({ key: u.userId ?? 'unknown', name: u.name, sub: u.staff ? t('credits.staffBadge') : (u.email !== u.name ? u.email : null), cents: u.cents, runs: u.runs })))}
        </div>
      )}
      <p className="text-[11px] text-gray-400 dark:text-gray-500">{t('credits.estimateNote')}</p>
    </div>
  );
}
