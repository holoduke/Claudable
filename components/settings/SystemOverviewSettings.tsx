"use client";
import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Container { name: string; image: string; status: string; state: string; ports: string; networks: string; project: string; role: string }
interface Network { name: string; driver: string; subnet: string; icc: string }
interface ProjectRow {
  id: string; name: string; stack: string; previewUrl: string | null; running: boolean;
  hasDatabase: boolean; agentContainerized: boolean; internalNetwork: string | null; containers: Container[];
}
interface Overview {
  host: string; agentContainerized: boolean; previewIsolation: boolean;
  projects: ProjectRow[]; unassigned: Container[]; networks: Network[]; generatedAt: number;
}

const ROLE_ICON: Record<string, string> = { frontend: '🖥️', backend: '⚙️', database: '🗄️', agent: '🤖', system: '🧩', other: '📦' };
const ROLE_LABEL: Record<string, string> = { frontend: 'Frontend', backend: 'Backend', database: 'Database', agent: 'Agent', system: 'System', other: 'Container' };

function isUp(state: string) { return state.includes('run') || state.includes('up'); }

function Pill({ tone, children }: { tone: 'green' | 'amber' | 'gray' | 'blue'; children: React.ReactNode }) {
  const map = {
    green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    gray: 'bg-gray-100 text-gray-500 dark:bg-white/6 dark:text-gray-400',
    blue: 'bg-[#DE7356]/10 text-[#DE7356] dark:bg-[#DE7356]/20 dark:text-[#DE7356]',
  };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-sm font-medium ${map[tone]}`}>{children}</span>;
}

function ContainerRow({ c }: { c: Container }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 text-sm">
      <span className="text-sm leading-none" aria-hidden>{ROLE_ICON[c.role] || '📦'}</span>
      <span className={`w-2 h-2 rounded-full shrink-0 ${isUp(c.state) ? 'bg-emerald-500' : 'bg-gray-400'}`} />
      <span className="text-[11px] text-gray-400 w-16 shrink-0">{ROLE_LABEL[c.role] || 'Container'}</span>
      <span className="font-mono text-[11px] text-gray-900 dark:text-gray-100 truncate min-w-0 flex-1">{c.name}</span>
      <span className="text-[10px] text-gray-400 hidden md:block truncate max-w-[22%]" title={c.ports}>{c.ports || '—'}</span>
      <span className="text-[10px] text-gray-500 dark:text-gray-400 shrink-0">{c.status}</span>
    </div>
  );
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

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-baseline gap-3">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Network</h3>
          {data?.host && <span className="text-xs font-mono text-gray-400 dark:text-gray-500">{data.host}</span>}
        </div>
        <button onClick={load} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-white/8 hover:bg-gray-50 dark:hover:bg-white/6">Refresh</button>
      </div>

      {data && (
        <div className="flex flex-wrap gap-2 mb-5">
          <Pill tone={data.agentContainerized ? 'green' : 'gray'}>
            Agent: {data.agentContainerized ? 'containerized' : 'in-process'}
          </Pill>
          <Pill tone={data.previewIsolation ? 'green' : 'gray'}>
            Preview isolation: {data.previewIsolation ? 'on' : 'off'}
          </Pill>
          <Pill tone="blue">{data.projects.length} projects</Pill>
        </div>
      )}

      {loading ? <p className="text-sm text-gray-500">Loading…</p> :
       error ? <p className="text-sm text-red-500">{error}</p> :
       !data ? null : (
        <div className="space-y-4">
          {data.projects.map((p) => (
            <div key={p.id} className="rounded-xl border border-gray-200 dark:border-white/8 overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 bg-gray-50 dark:bg-white/3">
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${p.running ? 'bg-emerald-500' : 'bg-gray-400'}`} title={p.running ? 'running' : 'stopped'} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">{p.name}</span>
                    {p.stack && <Pill tone="gray">{p.stack}</Pill>}
                    {p.hasDatabase && <Pill tone="blue">DB</Pill>}
                    <Pill tone={p.containers.some((c) => c.role === 'frontend' || c.role === 'backend') ? 'green' : 'amber'}>
                      {p.containers.some((c) => c.role === 'frontend' || c.role === 'backend') ? 'container' : 'in-process'}
                    </Pill>
                  </div>
                  <div className="font-mono text-[10px] text-gray-400 truncate">{p.id}</div>
                </div>
                {p.previewUrl && (
                  <a href={p.previewUrl} target="_blank" rel="noopener noreferrer"
                     className="text-xs px-2.5 py-1 rounded-lg border border-gray-200 dark:border-white/8 hover:bg-white dark:hover:bg-white/6 text-[#DE7356] shrink-0">
                    Open ↗
                  </a>
                )}
              </div>

              {/* Addresses */}
              <div className="px-4 py-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] border-b border-gray-100 dark:border-white/6">
                {p.previewUrl
                  ? <span className="text-gray-500">Public: <a href={p.previewUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-[#DE7356] hover:underline">{p.previewUrl.replace(/^https?:\/\//, '')}</a></span>
                  : <span className="text-gray-400">Public: — (local only)</span>}
                {p.internalNetwork
                  ? <span className="text-gray-500">Internal net: <span className="font-mono text-gray-600 dark:text-gray-300">{p.internalNetwork}</span></span>
                  : <span className="text-gray-400">Internal net: —</span>}
              </div>

              {/* Containers */}
              {p.containers.length > 0 ? (
                <div className="divide-y divide-gray-100 dark:divide-white/6">
                  {p.containers.map((c) => <ContainerRow key={c.name} c={c} />)}
                </div>
              ) : (
                <div className="px-4 py-2.5 text-[11px] text-gray-400">No running containers.</div>
              )}
            </div>
          ))}

          {/* Unassigned / system containers */}
          {data.unassigned.length > 0 && (
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Claudable system</h4>
              <div className="rounded-xl border border-gray-200 dark:border-white/8 divide-y divide-gray-100 dark:divide-white/6 overflow-hidden">
                {data.unassigned.map((c) => <ContainerRow key={c.name} c={c} />)}
              </div>
            </div>
          )}

          {/* Networks */}
          <div>
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Networks</h4>
            <div className="rounded-xl border border-gray-200 dark:border-white/8 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] text-gray-400 border-b border-gray-100 dark:border-white/6">
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Driver</th>
                    <th className="px-4 py-2 font-medium">Subnet</th>
                    <th className="px-4 py-2 font-medium">Inter-container</th>
                  </tr>
                </thead>
                <tbody>
                  {data.networks.map((n) => (
                    <tr key={n.name} className="border-b border-gray-50 dark:border-white/5 last:border-0">
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
