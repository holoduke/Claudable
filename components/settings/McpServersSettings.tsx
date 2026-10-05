'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage, responseErrorMessage } from '@/lib/client/api-error';
import { useT } from '@/contexts/I18nContext';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

type Transport = 'http' | 'sse' | 'stdio';

interface McpServerView {
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
  authType: 'none' | 'oauth';
  authStatus: 'none' | 'needs-auth' | 'connected' | 'expired';
  visibility: 'shared' | 'private';
}

interface Props {
  projectId: string;
}

interface McpCatalogEntry {
  name: string;
  label: string;
  description: string;
  transport: 'http' | 'sse';
  url: string;
  authType: 'none' | 'oauth';
  source: 'company' | 'curated';
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
  authType: 'none' as 'none' | 'oauth',
  visibility: 'shared' as 'shared' | 'private',
};

export default function McpServersSettings({ projectId }: Props) {
  const t = useT();
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [builtin, setBuiltin] = useState<{ name: string; label: string; description: string; active: boolean }[]>([]);
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [addingCatalogName, setAddingCatalogName] = useState<string | null>(null);
  const [accountConnectors, setAccountConnectors] = useState(false);
  const [shared, setShared] = useState<{ id: string; label: string; transport: string; url: string | null }[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/mcp-servers`);
      const json = await res.json();
      if (res.ok && json?.success) {
        // Response shape: { project: McpServerView[], builtin: BuiltinMcpView[] }
        const d = json.data ?? {};
        setServers(Array.isArray(d) ? d : d.project ?? []);
        setBuiltin(Array.isArray(d) ? [] : d.builtin ?? []);
        setCatalog(Array.isArray(d) ? [] : d.catalog ?? []);
        setAccountConnectors(Array.isArray(d) ? false : !!d.accountConnectors);
        setShared(Array.isArray(d) ? [] : d.shared ?? []);
      } else setError(apiErrorMessage(json, t('settings.mcp.loadFailed')));
    } catch {
      setError(t('settings.mcp.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => { void load(); }, [load]);

  // One-click add of a predefined catalog entry. OAuth servers then surface an
  // "Authenticate" button in the project list (no surprise redirect).
  const addFromCatalog = async (entry: McpCatalogEntry) => {
    setAddingCatalogName(entry.name);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: entry.name,
          label: entry.label,
          transport: entry.transport,
          url: entry.url,
          authType: entry.authType,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) throw new Error(apiErrorMessage(json, t('settings.mcp.addNamedFailed', { name: entry.label })));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.mcp.addNamedFailed', { name: entry.label }));
    } finally {
      setAddingCatalogName(null);
    }
  };

  const authenticate = async (s: McpServerView) => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/mcp-servers/${s.id}/oauth/start`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json?.success || !json.data?.authUrl) throw new Error(apiErrorMessage(json, t('settings.mcp.authStartFailed')));
      window.location.assign(json.data.authUrl); // redirect to the provider's consent screen
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.mcp.authStartFailed'));
    }
  };

  // Run a mutation, surface the server's error text on failure, and always
  // reload so the list shows the real (server) state afterwards.
  const mutate = async (url: string, init: RequestInit, fallback: string) => {
    setError(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) setError(await responseErrorMessage(res, fallback));
    } catch {
      setError(`${fallback} ${t('settings.mcp.networkError')}`);
    }
    await load();
  };

  const disconnect = (s: McpServerView) =>
    mutate(
      `${API_BASE}/api/projects/${projectId}/mcp-servers/${s.id}/oauth/disconnect`,
      { method: 'POST' },
      t('settings.mcp.disconnectFailed', { name: s.label || s.name }),
    );

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        label: form.label.trim() || form.name.trim(),
        transport: form.transport,
        visibility: form.visibility,
      };
      if (form.transport === 'stdio') {
        body.command = form.command.trim();
        body.args = form.argsText.split(/\s+/).filter(Boolean);
      } else {
        body.url = form.url.trim();
        body.authType = form.authType;
        // OAuth servers get their token via the auth flow — no manual header.
        if (form.authType !== 'oauth' && form.headerValue.trim() && form.headerKey.trim()) {
          body.headers = { [form.headerKey.trim()]: form.headerValue.trim() };
        }
      }
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) throw new Error(apiErrorMessage(json, t('settings.mcp.addFailed')));
      setForm({ ...EMPTY_FORM });
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.mcp.addFailed'));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (s: McpServerView) =>
    mutate(
      `${API_BASE}/api/projects/${projectId}/mcp-servers/${s.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !s.enabled }),
      },
      t(s.enabled ? 'settings.mcp.disableFailed' : 'settings.mcp.enableFailed', { name: s.label || s.name }),
    );

  const remove = async (s: McpServerView) => {
    if (!window.confirm(t('settings.mcp.confirmRemove', { name: s.label || s.name }))) return;
    await mutate(
      `${API_BASE}/api/projects/${projectId}/mcp-servers/${s.id}`,
      { method: 'DELETE' },
      t('settings.mcp.removeFailed', { name: s.label || s.name }),
    );
  };

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-1">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50">{t('settings.mcp.title')}</h3>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        {t('settings.mcp.intro')}
      </p>

      {error && (
        <div role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">{t('common.loading')}</p>
      ) : (
        <>
        {builtin.length > 0 && (
          <div className="mb-5">
            <h4 className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">{t('settings.mcp.builtin')}</h4>
            <div className="space-y-2">
              {builtin.map((b) => (
                <div key={b.name} className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-white/6 bg-gray-50/60 dark:bg-white/2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{b.label}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-gray-100 dark:bg-white/6 text-gray-500 dark:text-gray-400 font-mono">{b.name}</span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{b.description}</p>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-md ${b.active ? 'text-emerald-700 dark:text-emerald-300' : 'text-gray-400 dark:text-gray-500'}`}>
                    {b.active ? t('settings.mcp.active') : t('common.off')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {shared.length > 0 && (
          <div className="mb-5">
            <h4 className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">{t('settings.mcp.sharedByTeam')}</h4>
            <div className="space-y-2">
              {shared.map((s) => (
                <div key={s.id} className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-white/6 bg-gray-50/60 dark:bg-white/2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate">{s.label}</span>
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-sm bg-gray-100 dark:bg-white/6 text-gray-500 dark:text-gray-400">{s.transport}</span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{s.url || t('settings.mcp.stdioCommand')}</p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded-md text-emerald-700 dark:text-emerald-300">{t('settings.mcp.active')}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1.5">{t('settings.mcp.sharedHint')}</p>
          </div>
        )}
        {accountConnectors && (
          <div className="mb-5 rounded-lg border border-sky-200 dark:border-sky-900/50 bg-sky-50/60 dark:bg-sky-950/20 px-3 py-2.5">
            <p className="text-sm font-medium text-sky-800 dark:text-sky-300">{t('settings.mcp.accountConnectors')}</p>
            <p className="text-xs text-sky-700/80 dark:text-sky-400/80 mt-0.5">
              {t('settings.mcp.accountConnectorsDesc1')}{' '}
              <code className="px-1 py-0.5 rounded-sm bg-sky-100 dark:bg-sky-900/40 text-[11px]">claude mcp list</code>{' '}
              {t('settings.mcp.accountConnectorsDesc2')}
            </p>
          </div>
        )}
        <h4 className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">{t('settings.mcp.projectServers')}</h4>
        <p className="text-[11px] text-gray-400 dark:text-gray-500 -mt-1 mb-2">{t('settings.mcp.projectServersHint')}</p>
        <div className="space-y-2 mb-5">
          {servers.length === 0 && (
            <p className="text-sm text-gray-400 dark:text-gray-500">{t('settings.mcp.empty')}</p>
          )}
          {servers.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-white/8 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{s.label}</span>
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-sm bg-gray-100 dark:bg-white/6 text-gray-500 dark:text-gray-400">{s.transport}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-sm ${s.visibility === 'private' ? 'bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300' : 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'}`}>
                    {s.visibility === 'private' ? t('settings.mcp.badge.private') : t('settings.mcp.badge.shared')}
                  </span>
                  {(s.hasHeaders || s.hasEnv) && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300">{t('settings.mcp.badge.secret')}</span>
                  )}
                  {s.authType === 'oauth' && (
                    s.authStatus === 'connected' ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">{t('settings.mcp.badge.authenticated')}</span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-orange-100 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300">{s.authStatus === 'expired' ? t('settings.mcp.badge.authExpired') : t('settings.mcp.badge.needsAuth')}</span>
                    )
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{s.url || `${s.command ?? ''} ${s.args.join(' ')}`.trim()}</p>
              </div>
              {s.authType === 'oauth' && (
                s.authStatus === 'connected' ? (
                  <button onClick={() => disconnect(s)} className="text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-white/8 text-gray-500 hover:text-gray-700 dark:hover:text-gray-200">
                    {t('settings.mcp.disconnect')}
                  </button>
                ) : (
                  <button onClick={() => authenticate(s)} className="text-xs px-2 py-1 rounded-md bg-brand-500 text-white hover:bg-brand-600 transition-colors">
                    {t('settings.mcp.authenticate')}
                  </button>
                )
              )}
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

        {/* Predefined catalog — company-enabled + well-known servers not yet
            configured for this project. One click adds them. */}
        {catalog.length > 0 && (
          <div className="mb-5">
            <h4 className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">{t('settings.mcp.availableToAdd')}</h4>
            <div className="space-y-2">
              {catalog.map((c) => (
                <div key={c.name} className="flex items-center gap-3 rounded-lg border border-dashed border-gray-200 dark:border-white/8 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{c.label}</span>
                      {c.source === 'company' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-sky-100 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300">{t('settings.mcp.badge.company')}</span>
                      )}
                      {c.authType === 'oauth' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-gray-100 dark:bg-white/6 text-gray-500 dark:text-gray-400">{t('settings.mcp.badge.signInRequired')}</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{c.description || c.url}</p>
                  </div>
                  <button
                    onClick={() => addFromCatalog(c)}
                    disabled={addingCatalogName !== null}
                    className="text-xs px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-white/8 text-gray-700 dark:text-gray-200 hover:border-brand-500/50 hover:text-brand-500 disabled:opacity-50 transition-colors"
                  >
                    {addingCatalogName === c.name ? t('settings.mcp.adding') : t('common.add')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        </>
      )}

      {!adding ? (
        <div className="flex gap-2">
          <button onClick={() => { setForm({ ...EMPTY_FORM }); setAdding(true); }} className="text-sm px-3 py-2 rounded-lg bg-brand-500 text-white hover:bg-brand-600 transition-colors">
            {t('settings.mcp.addCustom')}
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-white/8 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs text-gray-500 dark:text-gray-400">
              {t('settings.mcp.form.name')}
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="relume" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
            </label>
            <label className="text-xs text-gray-500 dark:text-gray-400">
              {t('common.label')}
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Relume Library" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs text-gray-500 dark:text-gray-400">
              {t('settings.mcp.form.transport')}
              <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as Transport })} className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50">
                <option value="http">{t('settings.mcp.form.http')}</option>
                <option value="sse">{t('settings.mcp.form.sse')}</option>
                <option value="stdio">{t('settings.mcp.form.stdio')}</option>
              </select>
            </label>
            <label className="block text-xs text-gray-500 dark:text-gray-400">
              {t('settings.mcp.form.visibility')}
              <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as 'shared' | 'private' })} className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50">
                <option value="shared">{t('settings.mcp.form.shared')}</option>
                <option value="private">{t('settings.mcp.form.private')}</option>
              </select>
            </label>
          </div>
          {form.transport === 'stdio' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-xs text-gray-500 dark:text-gray-400">
                {t('settings.mcp.form.command')}
                <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
              </label>
              <label className="text-xs text-gray-500 dark:text-gray-400">
                {t('settings.mcp.form.args')}
                <input value={form.argsText} onChange={(e) => setForm({ ...form, argsText: e.target.value })} placeholder="-y some-mcp-package" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
              </label>
            </div>
          ) : (
            <>
              <label className="block text-xs text-gray-500 dark:text-gray-400">
                {t('settings.mcp.form.url')}
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://mcp.relume.io/mcp" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
              </label>
              <label className="block text-xs text-gray-500 dark:text-gray-400">
                {t('settings.mcp.form.auth')}
                <select value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value as 'none' | 'oauth' })} className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50">
                  <option value="none">{t('settings.mcp.form.authNone')}</option>
                  <option value="oauth">{t('settings.mcp.form.authOauth')}</option>
                </select>
              </label>
              {form.authType === 'oauth' ? (
                <p className="text-[11px] text-gray-400 dark:text-gray-500">
                  {t('settings.mcp.form.oauthHint')}
                </p>
              ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="text-xs text-gray-500 dark:text-gray-400">
                  {t('settings.mcp.form.header')}
                  <input value={form.headerKey} onChange={(e) => setForm({ ...form, headerKey: e.target.value })} className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
                </label>
                <label className="text-xs text-gray-500 dark:text-gray-400">
                  {t('settings.mcp.form.headerValue')}
                  <input value={form.headerValue} onChange={(e) => setForm({ ...form, headerValue: e.target.value })} placeholder="Bearer …" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
                </label>
              </div>
              )}
            </>
          )}
          <div className="flex gap-2 pt-1">
            <button disabled={saving} onClick={submit} className="text-sm px-3 py-2 rounded-lg bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50 transition-colors">
              {saving ? t('settings.mcp.adding') : t('settings.mcp.addServer')}
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
