'use client';

import React, { useCallback, useEffect, useState } from 'react';

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
      } else setError(json?.error || 'Failed to load MCP servers');
    } catch {
      setError('Failed to load MCP servers');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

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
      if (!res.ok || !json?.success) throw new Error(json?.error || `Failed to add ${entry.label}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to add ${entry.label}`);
    } finally {
      setAddingCatalogName(null);
    }
  };

  const authenticate = async (s: McpServerView) => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/mcp-servers/${s.id}/oauth/start`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json?.success || !json.data?.authUrl) throw new Error(json?.error || 'Could not start authentication');
      window.location.href = json.data.authUrl; // redirect to the provider's consent screen
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Authentication failed to start');
    }
  };

  const disconnect = async (s: McpServerView) => {
    await fetch(`${API_BASE}/api/projects/${projectId}/mcp-servers/${s.id}/oauth/disconnect`, { method: 'POST' });
    await load();
  };

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
      if (!res.ok || !json?.success) throw new Error(json?.error || 'Failed to add server');
      setForm({ ...EMPTY_FORM });
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add server');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (s: McpServerView) => {
    await fetch(`${API_BASE}/api/projects/${projectId}/mcp-servers/${s.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    await load();
  };

  const remove = async (s: McpServerView) => {
    await fetch(`${API_BASE}/api/projects/${projectId}/mcp-servers/${s.id}`, { method: 'DELETE' });
    await load();
  };

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-1">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50">MCP servers</h3>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        Give this project&apos;s agent access to extra tools via MCP servers. Add a remote
        (https) server or a stdio command. Enabled servers are attached to every agent run.
      </p>

      {error && (
        <div className="mb-4 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <>
        {builtin.length > 0 && (
          <div className="mb-5">
            <h4 className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">Provided by Claudable</h4>
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
                    {b.active ? 'Active' : 'Off'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {shared.length > 0 && (
          <div className="mb-5">
            <h4 className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">Shared by your team</h4>
            <div className="space-y-2">
              {shared.map((s) => (
                <div key={s.id} className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-white/6 bg-gray-50/60 dark:bg-white/2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate">{s.label}</span>
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-sm bg-gray-100 dark:bg-white/6 text-gray-500 dark:text-gray-400">{s.transport}</span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{s.url || 'stdio command'}</p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded-md text-emerald-700 dark:text-emerald-300">Active</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1.5">Managed by an admin in Global Settings → Shared MCP. Attached to every project automatically.</p>
          </div>
        )}
        {accountConnectors && (
          <div className="mb-5 rounded-lg border border-sky-200 dark:border-sky-900/50 bg-sky-50/60 dark:bg-sky-950/20 px-3 py-2.5">
            <p className="text-sm font-medium text-sky-800 dark:text-sky-300">Your Claude account connectors</p>
            <p className="text-xs text-sky-700/80 dark:text-sky-400/80 mt-0.5">
              The agent also inherits the managed connectors from your Claude subscription
              (Gmail, Drive, Calendar, Atlassian, and any others you&apos;ve connected) — the same
              set <code className="px-1 py-0.5 rounded-sm bg-sky-100 dark:bg-sky-900/40 text-[11px]">claude mcp list</code> shows.
              Manage or disconnect those in your Claude account settings.
            </p>
          </div>
        )}
        <h4 className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">Project servers</h4>
        <p className="text-[11px] text-gray-400 dark:text-gray-500 -mt-1 mb-2">Shared servers apply to everyone on this project; private ones only to your own agent runs.</p>
        <div className="space-y-2 mb-5">
          {servers.length === 0 && (
            <p className="text-sm text-gray-400 dark:text-gray-500">No project MCP servers yet.</p>
          )}
          {servers.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-white/8 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{s.label}</span>
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-sm bg-gray-100 dark:bg-white/6 text-gray-500 dark:text-gray-400">{s.transport}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-sm ${s.visibility === 'private' ? 'bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300' : 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'}`}>
                    {s.visibility === 'private' ? 'private' : 'shared'}
                  </span>
                  {(s.hasHeaders || s.hasEnv) && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300">secret</span>
                  )}
                  {s.authType === 'oauth' && (
                    s.authStatus === 'connected' ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">authenticated</span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-orange-100 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300">{s.authStatus === 'expired' ? 'auth expired' : 'needs auth'}</span>
                    )
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{s.url || `${s.command ?? ''} ${s.args.join(' ')}`.trim()}</p>
              </div>
              {s.authType === 'oauth' && (
                s.authStatus === 'connected' ? (
                  <button onClick={() => disconnect(s)} className="text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-white/8 text-gray-500 hover:text-gray-700 dark:hover:text-gray-200">
                    Disconnect
                  </button>
                ) : (
                  <button onClick={() => authenticate(s)} className="text-xs px-2 py-1 rounded-md bg-[#DE7356] text-white hover:bg-[#c9634a] transition-colors">
                    Authenticate
                  </button>
                )
              )}
              <button
                onClick={() => toggle(s)}
                className={`text-xs px-2 py-1 rounded-md border transition-colors ${s.enabled ? 'border-emerald-300 text-emerald-700 dark:text-emerald-300 dark:border-emerald-800' : 'border-gray-200 dark:border-white/8 text-gray-400'}`}
              >
                {s.enabled ? 'Enabled' : 'Disabled'}
              </button>
              <button onClick={() => remove(s)} className="text-xs px-2 py-1 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40">
                Remove
              </button>
            </div>
          ))}
        </div>

        {/* Predefined catalog — company-enabled + well-known servers not yet
            configured for this project. One click adds them. */}
        {catalog.length > 0 && (
          <div className="mb-5">
            <h4 className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">Available to add</h4>
            <div className="space-y-2">
              {catalog.map((c) => (
                <div key={c.name} className="flex items-center gap-3 rounded-lg border border-dashed border-gray-200 dark:border-white/8 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{c.label}</span>
                      {c.source === 'company' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-sky-100 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300">company</span>
                      )}
                      {c.authType === 'oauth' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-gray-100 dark:bg-white/6 text-gray-500 dark:text-gray-400">sign-in required</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{c.description || c.url}</p>
                  </div>
                  <button
                    onClick={() => addFromCatalog(c)}
                    disabled={addingCatalogName !== null}
                    className="text-xs px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-white/8 text-gray-700 dark:text-gray-200 hover:border-[#DE7356]/50 hover:text-[#DE7356] disabled:opacity-50 transition-colors"
                  >
                    {addingCatalogName === c.name ? 'Adding…' : 'Add'}
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
          <button onClick={() => { setForm({ ...EMPTY_FORM }); setAdding(true); }} className="text-sm px-3 py-2 rounded-lg bg-[#DE7356] text-white hover:bg-[#c9634a] transition-colors">
            Add custom MCP server
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-white/8 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-gray-500 dark:text-gray-400">
              Name (key)
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="relume" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
            </label>
            <label className="text-xs text-gray-500 dark:text-gray-400">
              Label
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Relume Library" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-gray-500 dark:text-gray-400">
              Transport
              <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as Transport })} className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50">
                <option value="http">Remote (HTTP)</option>
                <option value="sse">Remote (SSE)</option>
                <option value="stdio">Command (stdio)</option>
              </select>
            </label>
            <label className="block text-xs text-gray-500 dark:text-gray-400">
              Visibility
              <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as 'shared' | 'private' })} className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50">
                <option value="shared">Shared (whole project)</option>
                <option value="private">Private (only me)</option>
              </select>
            </label>
          </div>
          {form.transport === 'stdio' ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-gray-500 dark:text-gray-400">
                Command
                <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
              </label>
              <label className="text-xs text-gray-500 dark:text-gray-400">
                Args (space-separated)
                <input value={form.argsText} onChange={(e) => setForm({ ...form, argsText: e.target.value })} placeholder="-y some-mcp-package" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
              </label>
            </div>
          ) : (
            <>
              <label className="block text-xs text-gray-500 dark:text-gray-400">
                URL (https)
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://mcp.relume.io/mcp" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
              </label>
              <label className="block text-xs text-gray-500 dark:text-gray-400">
                Authentication
                <select value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value as 'none' | 'oauth' })} className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50">
                  <option value="none">None / static header</option>
                  <option value="oauth">OAuth (sign in after adding)</option>
                </select>
              </label>
              {form.authType === 'oauth' ? (
                <p className="text-[11px] text-gray-400 dark:text-gray-500">
                  You&apos;ll get an <span className="font-medium">Authenticate</span> button after adding — it opens the provider&apos;s sign-in and stores the token securely.
                </p>
              ) : (
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-gray-500 dark:text-gray-400">
                  Auth header (optional)
                  <input value={form.headerKey} onChange={(e) => setForm({ ...form, headerKey: e.target.value })} className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
                </label>
                <label className="text-xs text-gray-500 dark:text-gray-400">
                  Value (stored encrypted)
                  <input value={form.headerValue} onChange={(e) => setForm({ ...form, headerValue: e.target.value })} placeholder="Bearer …" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/8 bg-transparent text-sm text-gray-900 dark:text-gray-50" />
                </label>
              </div>
              )}
            </>
          )}
          <div className="flex gap-2 pt-1">
            <button disabled={saving} onClick={submit} className="text-sm px-3 py-2 rounded-lg bg-[#DE7356] text-white hover:bg-[#c9634a] disabled:opacity-50 transition-colors">
              {saving ? 'Adding…' : 'Add server'}
            </button>
            <button onClick={() => { setAdding(false); setForm({ ...EMPTY_FORM }); }} className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 text-gray-600 dark:text-gray-300">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
