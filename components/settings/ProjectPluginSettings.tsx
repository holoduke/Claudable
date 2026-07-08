'use client';

import React, { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface EffectivePlugin {
  marketplace: string;
  name: string;
  description?: string;
  enabled: boolean;
  synced: boolean;
}

/**
 * Per-project plugin view: the plugins available to this project (registered by
 * an admin in Global Settings → Plugins) with a per-project on/off toggle. The
 * toggle only overrides the org default for THIS project — mirrors the Skills
 * tab. Enabled plugins load into the project's agent as /<plugin>:<command>.
 */
export function ProjectPluginSettings({ projectId }: { projectId: string }) {
  const [plugins, setPlugins] = useState<EffectivePlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/plugins`);
      const json = await res.json();
      if (res.ok && json?.success) setPlugins(Array.isArray(json.data) ? json.data : []);
      else setError(json?.error || 'Failed to load plugins');
    } catch {
      setError('Failed to load plugins');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (p: EffectivePlugin, enabled: boolean) => {
    // Optimistic; reconcile from the server response.
    setPlugins((prev) => prev.map((x) => (x.marketplace === p.marketplace && x.name === p.name ? { ...x, enabled } : x)));
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/plugins`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketplace: p.marketplace, plugin: p.name, enabled }),
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json?.success && Array.isArray(json.data)) setPlugins(json.data);
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-50">Plugins</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Plugins registered for your team, with a per-project switch. Turning one off here disables it for this
          project only. Marketplaces are managed by an admin in Global Settings.
        </p>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : plugins.length === 0 ? (
        <p className="text-sm text-gray-400">No plugins are available. An admin can register a marketplace in Global Settings → Plugins.</p>
      ) : (
        <div className="space-y-1.5">
          {plugins.map((p) => (
            <label key={`${p.marketplace}/${p.name}`} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={p.enabled} disabled={!p.synced} onChange={(e) => toggle(p, e.target.checked)} />
              <span className="font-medium text-gray-800 dark:text-gray-100">{p.name}</span>
              <span className="text-[11px] text-gray-400">({p.marketplace})</span>
              {!p.synced && <span className="text-[11px] text-amber-500">not synced</span>}
              {p.description && <span className="text-xs text-gray-400 truncate">— {p.description}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
