"use client";
import { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface DesignEntry {
  id: string;
  name: string;
  description: string;
  preview: string | null;
}

interface Props {
  projectId: string;
}

export default function DesignSettings({ projectId }: Props) {
  const [catalog, setCatalog] = useState<DesignEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cRes, aRes] = await Promise.all([
        fetch(`${API_BASE}/api/design-skills`),
        fetch(`${API_BASE}/api/projects/${projectId}/design`),
      ]);
      const cJson = await cRes.json();
      const aJson = await aRes.json();
      if (cJson.success) setCatalog(cJson.data as DesignEntry[]);
      if (aJson.success) setActiveId(aJson.data?.activeId ?? null);
    } catch {
      setError('Failed to load designs');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (d) => d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q),
    );
  }, [catalog, query]);

  const choose = async (id: string | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/design`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Failed to apply design');
      setActiveId(json.data?.activeId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply design');
    } finally {
      setBusy(false);
    }
  };

  const active = catalog.find((d) => d.id === activeId) || null;

  return (
    <div className="p-6 space-y-5">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50 mb-1">Design</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Pick one design system. The agent uses it to style this project. Switching replaces the
          current design. {active ? <>Active: <span className="font-medium text-gray-900 dark:text-gray-50">{active.name}</span>.</> : 'No design selected.'}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search designs…"
          className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-200"
        />
        {activeId && (
          <button
            onClick={() => choose(null)}
            disabled={busy}
            className="px-3 py-2 text-sm font-medium border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 whitespace-nowrap"
          >
            Clear design
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">Loading designs…</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {filtered.map((d) => {
            const selected = d.id === activeId;
            return (
              <button
                key={d.id}
                onClick={() => choose(d.id)}
                disabled={busy}
                title={d.description}
                className={`group text-left rounded-xl border overflow-hidden transition-all disabled:opacity-60 ${
                  selected ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                <div className="aspect-[4/3] bg-gray-100 dark:bg-gray-800 overflow-hidden relative">
                  {d.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={d.preview} alt={d.name} loading="lazy" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400 dark:text-gray-500 text-xs">No preview</div>
                  )}
                  {selected && (
                    <span className="absolute top-2 right-2 text-[11px] font-semibold text-white bg-blue-600 px-2 py-0.5 rounded-full">
                      Active
                    </span>
                  )}
                </div>
                <div className="p-2.5">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{d.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{d.description}</p>
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="col-span-full py-8 text-center text-sm text-gray-400 dark:text-gray-500">No designs match “{query}”.</div>
          )}
        </div>
      )}
    </div>
  );
}
