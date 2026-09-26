"use client";
import { useEffect, useState } from 'react';
import { useI18n } from '@/contexts/I18nContext';
import { DATE_LOCALE } from '@/lib/i18n/config';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

type ApiToken = { id: string; name: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null };

interface ApiTokensSectionProps {
  onToast?: (message: string, type: 'success' | 'error') => void;
}

/**
 * Settings → Account → API tokens: create a token for a script or bot that acts as you (with your
 * project access, never admin rights), see when each was last used, and revoke it. The full token is
 * shown once, right after creating it. See lib/auth/api-token.ts.
 */
export default function ApiTokensSection({ onToast }: ApiTokensSectionProps) {
  const { t, locale } = useI18n();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  const date = (iso: string) => new Date(iso).toLocaleDateString(DATE_LOCALE[locale], { day: 'numeric', month: 'short', year: 'numeric' });
  const fail = (e: unknown) => onToast?.(t('account.apiTokens.failed', { error: e instanceof Error ? e.message : 'error' }), 'error');

  const fetchTokens = async (): Promise<ApiToken[]> => {
    const res = await fetch(`${API_BASE}/api/users/me/api-tokens`);
    const body = await res.json();
    if (!res.ok || !body.success) throw new Error(body.message || body.error || res.statusText);
    return body.data as ApiToken[];
  };

  const load = async () => {
    try {
      setTokens(await fetchTokens());
    } catch (e) {
      setTokens([]);
      fail(e);
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetchTokens()
      .then((list) => { if (!cancelled) setTokens(list); })
      .catch(() => { if (!cancelled) setTokens([]); });
    return () => { cancelled = true; };
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/users/me/api-tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.message || body.error || res.statusText);
      setFresh(body.data.token);
      setName('');
      onToast?.(t('account.apiTokens.created'), 'success');
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/users/me/api-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.message || body.error || res.statusText);
      onToast?.(t('account.apiTokens.revoked'), 'success');
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh);
      onToast?.(t('account.apiTokens.copied'), 'success');
    } catch (e) {
      fail(e);
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 dark:border-white/8 overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 dark:bg-white/3 border-b border-gray-200 dark:border-white/8">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-50">{t('account.apiTokens.title')}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('account.apiTokens.desc')}</p>
      </div>

      {fresh && (
        <div className="px-4 py-3 border-b border-gray-200 dark:border-white/8 bg-amber-50 dark:bg-amber-500/10">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-300 mb-2">{t('account.apiTokens.copyOnce')}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded-md bg-white dark:bg-white/6 border border-gray-200 dark:border-white/8 px-2 py-1 text-xs text-gray-800 dark:text-gray-100">{fresh}</code>
            <button type="button" onClick={copy} className="shrink-0 rounded-lg px-3 py-1 text-xs font-medium bg-brand-500 text-white hover:opacity-90">
              {t('account.apiTokens.copy')}
            </button>
          </div>
        </div>
      )}

      {tokens === null ? (
        <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>
      ) : tokens.length === 0 ? (
        <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{t('account.apiTokens.none')}</p>
      ) : (
        <ul className="divide-y divide-gray-200 dark:divide-white/8">
          {tokens.map((tk) => (
            <li key={tk.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{tk.name}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {tk.lastUsedAt ? t('account.apiTokens.lastUsed', { date: date(tk.lastUsedAt) }) : t('account.apiTokens.neverUsed')}
                  {tk.expiresAt ? ` · ${t('account.apiTokens.expires', { date: date(tk.expiresAt) })}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => revoke(tk.id)}
                disabled={busy}
                className="shrink-0 rounded-lg px-3 py-1 text-xs font-medium border border-gray-200 dark:border-white/8 text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-50"
              >
                {t('account.apiTokens.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-200 dark:border-white/8">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
          maxLength={80}
          placeholder={t('account.apiTokens.namePlaceholder')}
          className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-200 dark:border-white/8 rounded-lg bg-white dark:bg-white/6 text-gray-700 dark:text-gray-200 focus:outline-hidden"
        />
        <button
          type="button"
          onClick={create}
          disabled={busy || !name.trim()}
          className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium bg-brand-500 text-white hover:opacity-90 disabled:opacity-50"
        >
          {t('account.apiTokens.create')}
        </button>
      </div>
    </section>
  );
}
