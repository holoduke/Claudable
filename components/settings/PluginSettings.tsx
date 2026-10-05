'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage, responseErrorMessage } from '@/lib/client/api-error';
import { useT } from '@/contexts/I18nContext';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface CatalogPlugin {
  name: string;
  source: string;
  description?: string;
  version?: string;
}

interface MarketplaceView {
  id: string;
  name: string;
  gitUrl: string;
  ref: string | null;
  subpath: string | null;
  enabled: boolean;
  includeMcpServers: boolean;
  catalog: CatalogPlugin[];
  enabledPlugins: string[];
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  syncedRef: string | null;
}

const EMPTY_FORM = { name: '', gitUrl: '', ref: '', subpath: '', includeMcpServers: false };

/**
 * Admin management of Claude Code plugin MARKETPLACES — registered once and
 * loaded into every project's agent in the org. Register a repo, Sync to clone
 * + read its catalog, then toggle which plugins are on org-wide. Mirrors the
 * Shared MCP panel; per-project opt-outs live in each project's settings.
 */
export default function PluginSettings() {
  const t = useT();
  const [markets, setMarkets] = useState<MarketplaceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/plugins/marketplaces`);
      const json = await res.json();
      if (res.ok && json?.success) setMarkets(Array.isArray(json.data) ? json.data : []);
      else setError(apiErrorMessage(json, t('settings.plugins.loadFailed')));
    } catch {
      setError(t('settings.plugins.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const patchMarket = (id: string, next: MarketplaceView) =>
    setMarkets((prev) => prev.map((m) => (m.id === id ? next : m)));

  const addMarketplace = async () => {
    if (!form.name.trim() || !form.gitUrl.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/plugins/marketplaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          gitUrl: form.gitUrl.trim(),
          ref: form.ref.trim() || null,
          subpath: form.subpath.trim() || null,
          includeMcpServers: form.includeMcpServers,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) { setError(apiErrorMessage(json, t('settings.plugins.addFailed'))); return; }
      setForm({ ...EMPTY_FORM });
      setAdding(false);
      await load();
      // Immediately sync the freshly added marketplace so its catalog appears.
      void syncMarket(json.data.id);
    } catch {
      setError(t('settings.plugins.addFailed'));
    } finally {
      setSaving(false);
    }
  };

  const syncMarket = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/plugins/marketplaces/${id}/sync`, { method: 'POST' });
      const json = await res.json();
      if (res.ok && json?.success) patchMarket(id, json.data);
      else setError(apiErrorMessage(json, t('settings.plugins.syncFailed')));
    } catch {
      setError(t('settings.plugins.syncFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const toggleMarket = async (id: string, enabled: boolean) => {
    const res = await fetch(`${API_BASE}/api/plugins/marketplaces/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json?.success) patchMarket(id, json.data);
    else setError(apiErrorMessage(json, t(enabled ? 'settings.plugins.enableMarketFailed' : 'settings.plugins.disableMarketFailed')));
  };

  const togglePlugin = async (id: string, plugin: string, enabled: boolean) => {
    const res = await fetch(`${API_BASE}/api/plugins/marketplaces/${id}/plugins/${encodeURIComponent(plugin)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json?.success) patchMarket(id, json.data);
    else setError(apiErrorMessage(json, t(enabled ? 'settings.plugins.enablePluginFailed' : 'settings.plugins.disablePluginFailed', { plugin })));
  };

  const removeMarket = async (m: MarketplaceView) => {
    if (!window.confirm(t('settings.plugins.confirmRemove', { name: m.name }))) return;
    const id = m.id;
    setBusyId(id);
    const res = await fetch(`${API_BASE}/api/plugins/marketplaces/${id}`, { method: 'DELETE' });
    setBusyId(null);
    if (res.ok) setMarkets((prev) => prev.filter((m) => m.id !== id));
    else setError(await responseErrorMessage(res, t('settings.plugins.removeFailed')));
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50">{t('settings.plugins.title')}</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('settings.plugins.intro')}
        </p>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="text-sm text-gray-400">{t('common.loading')}</p>
      ) : (
        <div className="space-y-4">
          {markets.length === 0 && !adding && (
            <p className="text-sm text-gray-400">{t('settings.plugins.empty')}</p>
          )}

          {markets.map((m) => (
            <div key={m.id} className="rounded-lg border border-gray-200 dark:border-white/10 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-gray-50">{m.name}</span>
                    {!m.enabled && <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-500">{t('settings.plugins.disabledBadge')}</span>}
                  </div>
                  <p className="text-xs text-gray-400 truncate">{m.gitUrl}{m.ref ? `#${m.ref}` : ''}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    {m.lastSyncError
                      ? <span className="text-red-500">{t('settings.plugins.syncError', { error: m.lastSyncError })}</span>
                      : m.lastSyncedAt
                        ? `${t('settings.plugins.synced', { date: new Date(m.lastSyncedAt).toLocaleString() })}${m.syncedRef ? ` · ${m.syncedRef.slice(0, 7)}` : ''} · ${t('settings.plugins.pluginCount', { count: m.catalog.length })}`
                        : t('settings.plugins.notSynced')}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => syncMarket(m.id)}
                    disabled={busyId === m.id}
                    className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-white/15 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
                  >
                    {busyId === m.id ? t('settings.plugins.syncing') : t('settings.plugins.sync')}
                  </button>
                  <label className="text-xs flex items-center gap-1 text-gray-600 dark:text-gray-300">
                    <input type="checkbox" checked={m.enabled} onChange={(e) => toggleMarket(m.id, e.target.checked)} />
                    {t('common.on')}
                  </label>
                  <button onClick={() => removeMarket(m)} disabled={busyId === m.id} className="text-xs text-red-500 hover:text-red-700 px-1">{t('common.remove')}</button>
                </div>
              </div>

              {m.catalog.length > 0 && (
                <div className="mt-3 border-t border-gray-100 dark:border-white/5 pt-3 space-y-1.5">
                  {m.catalog.map((p) => (
                    <label key={p.name} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={m.enabledPlugins.includes(p.name)}
                        onChange={(e) => togglePlugin(m.id, p.name, e.target.checked)}
                      />
                      <span className="font-medium text-gray-800 dark:text-gray-100">{p.name}</span>
                      {p.description && <span className="text-xs text-gray-400 truncate">— {p.description}</span>}
                    </label>
                  ))}
                  <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mt-2">
                    <input type="checkbox" checked={m.includeMcpServers} onChange={async (e) => {
                      const res = await fetch(`${API_BASE}/api/plugins/marketplaces/${m.id}`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ includeMcpServers: e.target.checked }),
                      });
                      const json = await res.json().catch(() => null);
                      if (res.ok && json?.success) { patchMarket(m.id, json.data); void syncMarket(m.id); }
                      else setError(apiErrorMessage(json, t('settings.plugins.updateFailed')));
                    }} />
                    {t('settings.plugins.includeMcp')}
                  </label>
                </div>
              )}
            </div>
          ))}

          {adding ? (
            <div className="rounded-lg border border-gray-200 dark:border-white/10 p-4 space-y-2">
              <input className="w-full text-sm border border-gray-200 dark:border-white/10 rounded px-2 py-1 bg-transparent" placeholder={t('settings.plugins.namePlaceholder')} aria-label={t('common.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input className="w-full text-sm border border-gray-200 dark:border-white/10 rounded px-2 py-1 bg-transparent" placeholder={t('settings.plugins.gitUrlPlaceholder')} aria-label={t('settings.plugins.gitUrlPlaceholder')} value={form.gitUrl} onChange={(e) => setForm({ ...form, gitUrl: e.target.value })} />
              <div className="flex flex-col sm:flex-row gap-2">
                <input className="flex-1 text-sm border border-gray-200 dark:border-white/10 rounded px-2 py-1 bg-transparent" placeholder={t('settings.plugins.refPlaceholder')} aria-label={t('settings.plugins.refPlaceholder')} value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} />
                <input className="flex-1 text-sm border border-gray-200 dark:border-white/10 rounded px-2 py-1 bg-transparent" placeholder={t('settings.plugins.subpathPlaceholder')} aria-label={t('settings.plugins.subpathPlaceholder')} value={form.subpath} onChange={(e) => setForm({ ...form, subpath: e.target.value })} />
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button onClick={() => { setAdding(false); setForm({ ...EMPTY_FORM }); }} className="text-xs text-gray-500 px-2 py-1">{t('common.cancel')}</button>
                <button onClick={addMarketplace} disabled={saving || !form.name.trim() || !form.gitUrl.trim()} className="text-xs font-medium text-white bg-brand-500 hover:bg-brand-600 rounded px-3 py-1 disabled:opacity-50">
                  {saving ? t('settings.plugins.adding') : t('settings.plugins.addAndSync')}
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="text-sm text-brand-500 hover:underline">+ {t('settings.plugins.register')}</button>
          )}
        </div>
      )}
    </div>
  );
}
