"use client";
import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Container { name: string; image: string; status: string; state: string; ports: string; networks: string; project: string; role: string }
interface Network { name: string; driver: string; subnet: string; icc: string }
interface Overview { host: string; containers: Container[]; networks: Network[]; generatedAt: number }

const ROLE_ICON: Record<string, string> = { frontend: '🖥️', backend: '⚙️', database: '🗄️', system: '🧩', other: '📦' };

function dot(state: string) {
  return state.includes('run') || state.includes('up') ? 'bg-emerald-500' : 'bg-gray-400';
}

export default function SystemOverviewSettings() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await fetch(`${API_BASE}/api/system/overview`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) { setError(j?.error || 'Failed to load'); setData(null); }
      else setData((j?.data ?? j) as Overview);
    } catch { setError('Failed to load'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Group containers by owning project.
  const groups = (data?.containers ?? []).reduce<Record<string, Container[]>>((acc, c) => {
    (acc[c.project] ||= []).push(c); return acc;
  }, {});
  const projectKeys = Object.keys(groups).sort((a, b) => (a === 'system' ? 1 : b === 'system' ? -1 : a.localeCompare(b)));

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">System overview</h3>
        <button onClick={load} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800">Refresh</button>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        Every container and network on {data?.host || 'the host'}, grouped by the project that owns it.
      </p>

      {loading ? <p className="text-sm text-gray-500">Loading…</p> :
       error ? <p className="text-sm text-red-500">{error}</p> :
       !data ? null : (
        <div className="space-y-6">
          {/* Containers by project */}
          {projectKeys.map((proj) => (
            <div key={proj}>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2">{proj === 'system' ? 'System' : proj === '-' ? 'Unassigned' : proj}</h4>
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
                {groups[proj].map((c) => (
                  <div key={c.name} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="text-base leading-none" aria-hidden>{ROLE_ICON[c.role] || '📦'}</span>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${dot(c.state)}`} />
                    <span className="font-mono text-[12px] text-gray-900 dark:text-gray-100 truncate min-w-0 flex-1">{c.name}</span>
                    <span className="text-[11px] text-gray-500 dark:text-gray-400 hidden sm:block truncate max-w-[28%]">{c.image}</span>
                    <span className="text-[11px] text-gray-400 hidden md:block truncate max-w-[22%]">{c.ports || '—'}</span>
                    <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{c.status}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Networks */}
          <div>
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Networks</h4>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] text-gray-400 border-b border-gray-100 dark:border-gray-800">
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Driver</th>
                    <th className="px-4 py-2 font-medium">Subnet</th>
                    <th className="px-4 py-2 font-medium">Inter-container</th>
                  </tr>
                </thead>
                <tbody>
                  {data.networks.map((n) => (
                    <tr key={n.name} className="border-b border-gray-50 dark:border-gray-800/50 last:border-0">
                      <td className="px-4 py-2 font-mono text-[12px] text-gray-900 dark:text-gray-100">{n.name}</td>
                      <td className="px-4 py-2 text-[12px] text-gray-500">{n.driver}</td>
                      <td className="px-4 py-2 font-mono text-[12px] text-gray-500">{n.subnet || '—'}</td>
                      <td className="px-4 py-2 text-[12px]">
                        {n.icc === 'off' ? <span className="text-emerald-600">off (isolated)</span> : n.icc === 'on' ? <span className="text-amber-600">on</span> : <span className="text-gray-400">default</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
