"use client";
import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage } from '@/lib/client/api-error';
import { useT } from '@/contexts/I18nContext';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Status {
  configured: boolean;
  source: 'settings' | 'env' | null;
  appId: string | null;
  slug: string | null;
  updatedAt: string | null;
}

/**
 * Superadmin panel for the GitHub App Claudable pushes to github.com with.
 * The private key is write-only: it is sent once, validated against GitHub and
 * stored encrypted; this panel never receives it back.
 */
export default function GithubAppSettings() {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [appId, setAppId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/settings/github-app`, { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (r.ok) setStatus((j?.data ?? j) as Status);
      else setMessage({ kind: 'error', text: apiErrorMessage(j, t('settings.githubApp.loadFailed')) });
    } catch {
      setMessage({ kind: 'error', text: t('settings.githubApp.loadFailed') });
    }
  }, [t]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true); setMessage(null);
    try {
      const r = await fetch(`${API_BASE}/api/settings/github-app`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId.trim(), private_key: privateKey }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setMessage({ kind: 'error', text: apiErrorMessage(j, t('settings.githubApp.saveFailed')) });
        return;
      }
      setStatus((j?.data ?? j) as Status);
      setPrivateKey('');
      setAppId('');
      setMessage({ kind: 'ok', text: t('settings.githubApp.saved') });
    } catch {
      setMessage({ kind: 'error', text: t('settings.githubApp.saveFailed') });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t('settings.githubApp.removeConfirm'))) return;
    setBusy(true); setMessage(null);
    try {
      const r = await fetch(`${API_BASE}/api/settings/github-app`, { method: 'DELETE' });
      const j = await r.json().catch(() => null);
      if (r.ok) setStatus((j?.data ?? j) as Status);
      else setMessage({ kind: 'error', text: apiErrorMessage(j, t('settings.githubApp.saveFailed')) });
    } finally {
      setBusy(false);
    }
  };

  const onKeyFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 10_000) {
      setMessage({ kind: 'error', text: t('settings.githubApp.keyTooLarge') });
      return;
    }
    setPrivateKey(await file.text());
  };

  return (
    <section className="mb-8 rounded-xl border border-gray-200 dark:border-white/8 p-4">
      <div className="flex items-center justify-between gap-3 mb-1">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('settings.githubApp.title')}</h3>
        {status && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-sm font-medium ${status.configured
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
            : 'bg-gray-100 text-gray-500 dark:bg-white/6 dark:text-gray-400'}`}>
            {t(status.configured ? 'settings.githubApp.active' : 'settings.githubApp.notConfigured')}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t('settings.githubApp.description')}</p>

      {status?.configured && (
        <div className="text-xs text-gray-700 dark:text-gray-300 mb-4 space-y-0.5">
          <div>{t('settings.githubApp.appLabel')}: <span className="font-mono">{status.slug ?? '—'}</span> (ID <span className="font-mono">{status.appId}</span>)</div>
          <div className="text-gray-500 dark:text-gray-400">
            {status.source === 'env' ? t('settings.githubApp.fromEnv') : t('settings.githubApp.fromSettings', {
              date: status.updatedAt ? new Date(status.updatedAt).toLocaleString() : '—',
            })}
          </div>
        </div>
      )}

      <div className="grid gap-2 max-w-xl">
        <label className="text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="github-app-id">{t('settings.githubApp.appId')}</label>
        <input
          id="github-app-id"
          inputMode="numeric"
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          placeholder="123456"
          className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-white dark:bg-white/3"
        />
        <label className="text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="github-app-key">{t('settings.githubApp.privateKey')}</label>
        <textarea
          id="github-app-key"
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          placeholder="-----BEGIN RSA PRIVATE KEY-----"
          className="text-xs font-mono px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-white dark:bg-white/3"
        />
        <input type="file" accept=".pem,application/x-pem-file,text/plain" onChange={(e) => onKeyFile(e.target.files?.[0])}
          className="text-xs text-gray-500" aria-label={t('settings.githubApp.keyFile')} />
        <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('settings.githubApp.permissions')}</p>
        <div className="flex gap-2 mt-1">
          <button type="button" onClick={save} disabled={busy || !appId.trim() || !privateKey.trim()}
            className="text-sm px-3 py-1.5 rounded-lg bg-brand-500 text-white disabled:opacity-50">
            {busy ? t('settings.githubApp.checking') : t('settings.githubApp.save')}
          </button>
          {status?.source === 'settings' && (
            <button type="button" onClick={remove} disabled={busy}
              className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 dark:border-white/8 text-red-600">
              {t('settings.githubApp.remove')}
            </button>
          )}
        </div>
        {message && (
          <p role={message.kind === 'error' ? 'alert' : 'status'}
            className={`text-xs ${message.kind === 'error' ? 'text-red-600' : 'text-emerald-600'}`}>{message.text}</p>
        )}
      </div>
    </section>
  );
}
