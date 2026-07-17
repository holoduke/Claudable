'use client';

import React, { useCallback, useEffect, useState } from 'react';

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
      else setError(json?.error || 'Failed to load plugin marketplaces');
    } catch {
      setError('Failed to load plugin marketplaces');
    } finally {
      setLoading(false);
    }
  }, []);

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
      if (!res.ok || !json?.success) { setError(json?.error || 'Failed to add marketplace'); return; }
      setForm({ ...EMPTY_FORM });
      setAdding(false);
      await load();
      // Immediately sync the freshly added marketplace so its catalog appears.
      void syncMarket(json.data.id);
    } catch {
      setError('Failed to add marketplace');
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
      else setError(json?.error || 'Sync failed');
    } catch {
      setError('Sync failed');
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
  };

  const togglePlugin = async (id: string, plugin: string, enabled: boolean) => {
    const res = await fetch(`${API_BASE}/api/plugins/marketplaces/${id}/plugins/${encodeURIComponent(plugin)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json?.success) patchMarket(id, json.data);
  };

  const removeMarket = async (id: string) => {
    setBusyId(id);
    const res = await fetch(`${API_BASE}/api/plugins/marketplaces/${id}`, { method: 'DELETE' });
    setBusyId(null);
    if (res.ok) setMarkets((prev) => prev.filter((m) => m.id !== id));
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-50">Plugins</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Register a Claude Code plugin marketplace (a git repo). Its enabled plugins — commands, agents and
          skills — load into every project&apos;s agent, exactly like the CLI. Bundled MCP servers are skipped by
          default because their binaries can&apos;t run in the sandbox.
        </p>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="space-y-4">
          {markets.length === 0 && !adding && (
            <p className="text-sm text-gray-400">No marketplaces registered yet.</p>
          )}

          {markets.map((m) => (
            <div key={m.id} className="rounded-lg border border-gray-200 dark:border-white/10 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-gray-50">{m.name}</span>
                    {!m.enabled && <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-500">disabled</span>}
                  </div>
                  <p className="text-xs text-gray-400 truncate">{m.gitUrl}{m.ref ? `#${m.ref}` : ''}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    {m.lastSyncError
                      ? <span className="text-red-500">Sync error: {m.lastSyncError}</span>
                      : m.lastSyncedAt
                        ? `Synced ${new Date(m.lastSyncedAt).toLocaleString()}${m.syncedRef ? ` · ${m.syncedRef.slice(0, 7)}` : ''} · ${m.catalog.length} plugin(s)`
                        : 'Not synced yet'}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => syncMarket(m.id)}
                    disabled={busyId === m.id}
                    className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-white/15 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
                  >
                    {busyId === m.id ? 'Syncing…' : 'Sync'}
                  </button>
                  <label className="text-xs flex items-center gap-1 text-gray-600 dark:text-gray-300">
                    <input type="checkbox" checked={m.enabled} onChange={(e) => toggleMarket(m.id, e.target.checked)} />
                    on
                  </label>
                  <button onClick={() => removeMarket(m.id)} disabled={busyId === m.id} className="text-xs text-red-500 hover:text-red-700 px-1">Remove</button>
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
                    }} />
                    Include the plugins&apos; bundled MCP servers (only if they run on linux/amd64 — re-syncs)
                  </label>
                </div>
              )}
            </div>
          ))}

          {adding ? (
            <div className="rounded-lg border border-gray-200 dark:border-white/10 p-4 space-y-2">
              <input className="w-full text-sm border border-gray-200 dark:border-white/10 rounded px-2 py-1 bg-transparent" placeholder="Name (e.g. newstory-dev-tools)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input className="w-full text-sm border border-gray-200 dark:border-white/10 rounded px-2 py-1 bg-transparent" placeholder="https git URL" value={form.gitUrl} onChange={(e) => setForm({ ...form, gitUrl: e.target.value })} />
              <div className="flex gap-2">
                <input className="flex-1 text-sm border border-gray-200 dark:border-white/10 rounded px-2 py-1 bg-transparent" placeholder="branch/tag (optional)" value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} />
                <input className="flex-1 text-sm border border-gray-200 dark:border-white/10 rounded px-2 py-1 bg-transparent" placeholder="subpath (optional)" value={form.subpath} onChange={(e) => setForm({ ...form, subpath: e.target.value })} />
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button onClick={() => { setAdding(false); setForm({ ...EMPTY_FORM }); }} className="text-xs text-gray-500 px-2 py-1">Cancel</button>
                <button onClick={addMarketplace} disabled={saving || !form.name.trim() || !form.gitUrl.trim()} className="text-xs font-medium text-white bg-brand-500 hover:bg-brand-600 rounded px-3 py-1 disabled:opacity-50">
                  {saving ? 'Adding…' : 'Add & sync'}
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="text-sm text-brand-500 hover:underline">+ Register a marketplace</button>
          )}
        </div>
      )}
    </div>
  );
}
