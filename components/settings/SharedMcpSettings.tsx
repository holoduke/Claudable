'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage, responseErrorMessage } from '@/lib/client/api-error';
import { useT } from '@/contexts/I18nContext';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

type Transport = 'http' | 'sse' | 'stdio';

interface SharedMcpView {
  id: string;
  name: string;
  label: string;
  transport: Transport;
  url: string | null;
  command: string | null;
  args: string[];
  hasHeaders: boolean;
  hasEnv: boolean;
  enabled: boolean;
}

const EMPTY_FORM = {
  name: '',
  label: '',
  transport: 'http' as Transport,
  url: '',
  command: 'npx',
  argsText: '',
  headerKey: 'Authorization',
  headerValue: '',
};

/**
 * Admin management of ORG-SHARED MCP servers — added once, auto-attached to
 * every project's agent in the org. Shared servers use a single shared
 * credential (a static auth header), not per-user OAuth.
 */
export default function SharedMcpSettings() {
  const t = useT();
  const [servers, setServers] = useState<SharedMcpView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/shared-mcp-servers`);
      const json = await res.json();
      if (res.ok && json?.success) setServers(Array.isArray(json.data) ? json.data : []);
      else setError(apiErrorMessage(json, t('settings.sharedMcp.loadFailed')));
    } catch {
      setError(t('settings.sharedMcp.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        label: form.label.trim() || form.name.trim(),
        transport: form.transport,
      };
      if (form.transport === 'stdio') {
        body.command = form.command.trim();
        body.args = form.argsText.split(/\s+/).filter(Boolean);
      } else {
        body.url = form.url.trim();
        if (form.headerValue.trim() && form.headerKey.trim()) {
          body.headers = { [form.headerKey.trim()]: form.headerValue.trim() };
        }
      }
      const res = await fetch(`${API_BASE}/api/shared-mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) throw new Error(apiErrorMessage(json, t('settings.sharedMcp.addFailed')));
      setForm({ ...EMPTY_FORM });
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.sharedMcp.addFailed'));
    } finally {
      setSaving(false);
    }
  };

  // Run a mutation, show the server's error text on failure, then reload.
  const mutate = async (url: string, init: RequestInit, fallback: string) => {
    setError(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) setError(await responseErrorMessage(res, fallback));
    } catch {
      setError(t('settings.sharedMcp.networkError', { action: fallback }));
    }
    await load();
  };

  const toggle = (s: SharedMcpView) =>
    mutate(
      `${API_BASE}/api/shared-mcp-servers/${s.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !s.enabled }),
      },
      t(s.enabled ? 'settings.sharedMcp.disableFailed' : 'settings.sharedMcp.enableFailed', { label: s.label }),
    );

  const remove = async (s: SharedMcpView) => {
    if (!window.confirm(t('settings.sharedMcp.confirmRemove', { label: s.label }))) return;
    await mutate(`${API_BASE}/api/shared-mcp-servers/${s.id}`, { method: 'DELETE' }, t('settings.sharedMcp.removeFailed', { label: s.label }));
  };

  return (
    <div>
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50">{t('settings.sharedMcp.title')}</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 mb-5">
        {t('settings.sharedMcp.intro')}
      </p>

      {error && (
        <div className="mb-4 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">{t('common.loading')}</p>
      ) : (
        <div className="space-y-2 mb-5">
          {servers.length === 0 && (
            <p className="text-sm text-gray-400 dark:text-gray-500">{t('settings.sharedMcp.empty')}</p>
          )}
          {servers.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-white/8 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{s.label}</span>
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-sm bg-gray-100 dark:bg-white/6 text-gray-500 dark:text-gray-400">{s.transport}</span>
                  {(s.hasHeaders || s.hasEnv) && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300">{t('settings.sharedMcp.secret')}</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{s.url || `${s.command ?? ''} ${s.args.join(' ')}`.trim()}</p>
              </div>
              <button
                onClick={() => toggle(s)}
                aria-pressed={s.enabled}
                className={`text-xs px-2 py-1 rounded-md border transition-colors ${s.enabled ? 'border-emerald-300 text-emerald-700 dark:text-emerald-300 dark:border-emerald-800' : 'border-gray-200 dark:border-white/8 text-gray-400'}`}
              >
                {s.enabled ? t('common.enabled') : t('common.disabled')}
              </button>
              <button onClick={() => remove(s)} className="text-xs px-2 py-1 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40">
                {t('common.remove')}
              </button>
            </div>
          ))}
        </div>
      )}

      {!adding ? (
        <button onClick={() => { setForm({ ...EMPTY_FORM }); setAdding(true); }} className="text-sm px-3 py-2 rounded-lg bg-brand-500 text-white hover:bg-brand-600 transition-colors">
          {t('settings.sharedMcp.add')}
        </button>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-white/8 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs text-gray-500 dark:text-gray-400">
              {t('settings.sharedMcp.nameKey')}
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="company-docs" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
            </label>
            <label className="text-xs text-gray-500 dark:text-gray-400">
              {t('common.label')}
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Company Docs" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
            </label>
          </div>
          <label className="block text-xs text-gray-500 dark:text-gray-400">
            {t('settings.sharedMcp.transport')}
            <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as Transport })} className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50">
              <option value="http">{t('settings.sharedMcp.remoteHttp')}</option>
              <option value="sse">{t('settings.sharedMcp.remoteSse')}</option>
              <option value="stdio">{t('settings.sharedMcp.commandStdio')}</option>
            </select>
          </label>
          {form.transport === 'stdio' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-xs text-gray-500 dark:text-gray-400">
                {t('settings.sharedMcp.command')}
                <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
              </label>
              <label className="text-xs text-gray-500 dark:text-gray-400">
                {t('settings.sharedMcp.args')}
                <input value={form.argsText} onChange={(e) => setForm({ ...form, argsText: e.target.value })} placeholder="-y some-mcp-package" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
              </label>
            </div>
          ) : (
            <>
              <label className="block text-xs text-gray-500 dark:text-gray-400">
                {t('settings.sharedMcp.url')}
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://mcp.example.com/mcp" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="text-xs text-gray-500 dark:text-gray-400">
                  {t('settings.sharedMcp.authHeader')}
                  <input value={form.headerKey} onChange={(e) => setForm({ ...form, headerKey: e.target.value })} className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
                </label>
                <label className="text-xs text-gray-500 dark:text-gray-400">
                  {t('settings.sharedMcp.headerValue')}
                  <input value={form.headerValue} onChange={(e) => setForm({ ...form, headerValue: e.target.value })} placeholder="Bearer …" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
                </label>
              </div>
            </>
          )}
          <div className="flex gap-2 pt-1">
            <button disabled={saving} onClick={submit} className="text-sm px-3 py-2 rounded-lg bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50 transition-colors">
              {saving ? t('settings.sharedMcp.adding') : t('settings.sharedMcp.addServer')}
            </button>
            <button onClick={() => { setAdding(false); setForm({ ...EMPTY_FORM }); }} className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 text-gray-600 dark:text-gray-300">
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
