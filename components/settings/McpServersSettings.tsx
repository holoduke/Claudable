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
}

interface Props {
  projectId: string;
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
};

export default function McpServersSettings({ projectId }: Props) {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/mcp-servers`);
      const json = await res.json();
      if (res.ok && json?.success) setServers(json.data ?? []);
      else setError(json?.error || 'Failed to load MCP servers');
    } catch {
      setError('Failed to load MCP servers');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const applyRelumePreset = () => {
    // Relume uses OAuth (sign in with your Relume account) — not a static token.
    // Prefill the endpoint + authType=oauth; the user authenticates after adding.
    setForm({
      ...EMPTY_FORM,
      name: 'relume',
      label: 'Relume Library',
      transport: 'http',
      url: 'https://relume-library-mcp.relume.io/mcp',
      authType: 'oauth',
    });
    setAdding(true);
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
        <div className="space-y-2 mb-5">
          {servers.length === 0 && (
            <p className="text-sm text-gray-400 dark:text-gray-500">No MCP servers yet.</p>
          )}
          {servers.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-white/[0.08] px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{s.label}</span>
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/[0.06] text-gray-500 dark:text-gray-400">{s.transport}</span>
                  {(s.hasHeaders || s.hasEnv) && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300">secret</span>
                  )}
                  {s.authType === 'oauth' && (
                    s.authStatus === 'connected' ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">authenticated</span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300">{s.authStatus === 'expired' ? 'auth expired' : 'needs auth'}</span>
                    )
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{s.url || `${s.command ?? ''} ${s.args.join(' ')}`.trim()}</p>
              </div>
              {s.authType === 'oauth' && (
                s.authStatus === 'connected' ? (
                  <button onClick={() => disconnect(s)} className="text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-white/[0.08] text-gray-500 hover:text-gray-700 dark:hover:text-gray-200">
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
                className={`text-xs px-2 py-1 rounded-md border transition-colors ${s.enabled ? 'border-emerald-300 text-emerald-700 dark:text-emerald-300 dark:border-emerald-800' : 'border-gray-200 dark:border-white/[0.08] text-gray-400'}`}
              >
                {s.enabled ? 'Enabled' : 'Disabled'}
              </button>
              <button onClick={() => remove(s)} className="text-xs px-2 py-1 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {!adding ? (
        <div className="flex gap-2">
          <button onClick={() => { setForm({ ...EMPTY_FORM }); setAdding(true); }} className="text-sm px-3 py-2 rounded-lg bg-[#DE7356] text-white hover:bg-[#c9634a] transition-colors">
            Add MCP server
          </button>
          <button onClick={applyRelumePreset} className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/[0.08] text-gray-700 dark:text-gray-200 hover:border-[#DE7356]/40 transition-colors">
            + Relume Library
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-gray-500 dark:text-gray-400">
              Name (key)
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="relume" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/[0.08] bg-transparent text-sm text-gray-900 dark:text-gray-50" />
            </label>
            <label className="text-xs text-gray-500 dark:text-gray-400">
              Label
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Relume Library" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/[0.08] bg-transparent text-sm text-gray-900 dark:text-gray-50" />
            </label>
          </div>
          <label className="block text-xs text-gray-500 dark:text-gray-400">
            Transport
            <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as Transport })} className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/[0.08] bg-transparent text-sm text-gray-900 dark:text-gray-50">
              <option value="http">Remote (HTTP)</option>
              <option value="sse">Remote (SSE)</option>
              <option value="stdio">Command (stdio)</option>
            </select>
          </label>
          {form.transport === 'stdio' ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-gray-500 dark:text-gray-400">
                Command
                <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/[0.08] bg-transparent text-sm text-gray-900 dark:text-gray-50" />
              </label>
              <label className="text-xs text-gray-500 dark:text-gray-400">
                Args (space-separated)
                <input value={form.argsText} onChange={(e) => setForm({ ...form, argsText: e.target.value })} placeholder="-y some-mcp-package" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/[0.08] bg-transparent text-sm text-gray-900 dark:text-gray-50" />
              </label>
            </div>
          ) : (
            <>
              <label className="block text-xs text-gray-500 dark:text-gray-400">
                URL (https)
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://mcp.relume.io/mcp" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/[0.08] bg-transparent text-sm text-gray-900 dark:text-gray-50" />
              </label>
              <label className="block text-xs text-gray-500 dark:text-gray-400">
                Authentication
                <select value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value as 'none' | 'oauth' })} className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/[0.08] bg-transparent text-sm text-gray-900 dark:text-gray-50">
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
                  <input value={form.headerKey} onChange={(e) => setForm({ ...form, headerKey: e.target.value })} className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/[0.08] bg-transparent text-sm text-gray-900 dark:text-gray-50" />
                </label>
                <label className="text-xs text-gray-500 dark:text-gray-400">
                  Value (stored encrypted)
                  <input value={form.headerValue} onChange={(e) => setForm({ ...form, headerValue: e.target.value })} placeholder="Bearer …" className="mt-1 w-full px-2.5 py-2 rounded-md border border-gray-200 dark:border-white/[0.08] bg-transparent text-sm text-gray-900 dark:text-gray-50" />
                </label>
              </div>
              )}
            </>
          )}
          <div className="flex gap-2 pt-1">
            <button disabled={saving} onClick={submit} className="text-sm px-3 py-2 rounded-lg bg-[#DE7356] text-white hover:bg-[#c9634a] disabled:opacity-50 transition-colors">
              {saving ? 'Adding…' : 'Add server'}
            </button>
            <button onClick={() => { setAdding(false); setForm({ ...EMPTY_FORM }); }} className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/[0.08] text-gray-600 dark:text-gray-300">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
