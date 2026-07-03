"use client";
import { useCallback, useEffect, useState } from 'react';
import { BACKEND_STACKS } from '@/lib/config/backend-stacks';
import { DATABASES } from '@/lib/config/databases';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Container {
  kind: 'frontend' | 'backend' | 'database';
  name: string;
  type: string;
  status: string;
  url: string | null;
  description: string;
  removable: boolean;
}

const KIND_ICON: Record<string, string> = { frontend: '🖥️', backend: '⚙️', database: '🗄️' };

function statusColor(s: string): string {
  if (s === 'running' || s === 'provisioned') return 'bg-emerald-500';
  if (s === 'file') return 'bg-blue-400';
  return 'bg-gray-400';
}

export default function ContainersSettings({ projectId }: { projectId: string }) {
  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [addBackend, setAddBackend] = useState(false);
  const [addDatabase, setAddDatabase] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/containers`);
      const j = await r.json();
      setContainers((j?.data?.containers ?? j?.containers ?? []) as Container[]);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const add = async (payload: Record<string, string>) => {
    setBusy(true);
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/containers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      setAddBackend(false); setAddDatabase(false);
      await load();
    } finally { setBusy(false); }
  };
  const remove = async (kind: string) => {
    setBusy(true);
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/containers?kind=${kind}`, { method: 'DELETE' });
      await load();
    } finally { setBusy(false); }
  };

  const hasBackend = containers.some((c) => c.kind === 'backend');
  const hasDatabase = containers.some((c) => c.kind === 'database');

  // Image-generation capability (per-project connection).
  const [img, setImg] = useState<{ connected: boolean; hasOwnKey: boolean; usesGlobalKey: boolean; globalAvailable: boolean } | null>(null);
  const [imgKey, setImgKey] = useState('');
  const [imgBusy, setImgBusy] = useState(false);
  const loadImg = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/image-capability`);
      const j = await r.json();
      setImg((j?.data ?? j) as typeof img);
    } catch { /* ignore */ }
  }, [projectId]);
  useEffect(() => { loadImg(); }, [loadImg]);
  const connectImg = async () => {
    setImgBusy(true);
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/image-capability`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imgKey.trim() ? { apiKey: imgKey.trim() } : {}),
      });
      setImgKey(''); await loadImg();
    } finally { setImgBusy(false); }
  };
  const disconnectImg = async () => {
    setImgBusy(true);
    try { await fetch(`${API_BASE}/api/projects/${projectId}/image-capability`, { method: 'DELETE' }); await loadImg(); }
    finally { setImgBusy(false); }
  };

  return (
    <div>
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Containers</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 mb-5">
        The services that make up this project. Each runs as its own isolated, egress-locked container.
        The agent edits the code; these run it.
      </p>

      {loading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      ) : (
        <div className="space-y-3">
          {containers.map((c) => (
            <div key={c.kind} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <span className="text-xl leading-none mt-0.5" aria-hidden>{KIND_ICON[c.kind]}</span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{c.name}</span>
                      <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">{c.type}</span>
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                        <span className={`w-2 h-2 rounded-full ${statusColor(c.status)}`} />{c.status}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{c.description}</p>
                    {c.url && (
                      <a href={c.url} target="_blank" rel="noreferrer" className="text-xs text-[#DE7356] break-all mt-1 inline-block">{c.url}</a>
                    )}
                  </div>
                </div>
                {c.removable && (
                  <button onClick={() => remove(c.kind)} disabled={busy}
                    className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50 shrink-0">Remove</button>
                )}
              </div>
            </div>
          ))}

          {/* Add actions */}
          <div className="flex flex-wrap gap-2 pt-1">
            {!hasBackend && (
              <div className="relative">
                <button onClick={() => setAddBackend(v => !v)} disabled={busy}
                  className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200 disabled:opacity-50">
                  + Add backend
                </button>
                {addBackend && (
                  <div className="absolute z-20 mt-1 w-72 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg p-1">
                    {BACKEND_STACKS.map(b => (
                      <button key={b.id} onClick={() => add({ backendId: b.id })}
                        className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-50">{b.name}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">{b.description}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!hasDatabase && (
              <div className="relative">
                <button onClick={() => setAddDatabase(v => !v)} disabled={busy}
                  className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200 disabled:opacity-50">
                  + Add database
                </button>
                {addDatabase && (
                  <div className="absolute z-20 mt-1 w-72 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg p-1">
                    {DATABASES.map(d => (
                      <button key={d.id} onClick={() => add({ databaseId: d.id })}
                        className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-50">{d.name}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">{d.description}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Capabilities — shared services a project connects to */}
          <div className="pt-4 mt-2 border-t border-gray-100 dark:border-gray-800">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">Capabilities</h4>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <span className="text-xl leading-none mt-0.5" aria-hidden>🎨</span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Image generation</span>
                      {img?.connected ? (
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400"><span className="w-2 h-2 rounded-full bg-emerald-500" />connected</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-400"><span className="w-2 h-2 rounded-full bg-gray-400" />not connected</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Lets the agent generate images (xAI / Grok) into this project.
                      {img?.connected && (img.hasOwnKey ? ' Using this project’s own key.' : img.usesGlobalKey ? ' Using the shared key.' : ' No key available — add one below.')}
                    </p>
                  </div>
                </div>
                {img?.connected && (
                  <button onClick={disconnectImg} disabled={imgBusy} className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50 shrink-0">Disconnect</button>
                )}
              </div>
              {!img?.connected && (
                <div className="mt-3 flex flex-col sm:flex-row gap-2">
                  <input
                    type="password" value={imgKey} onChange={(e) => setImgKey(e.target.value)}
                    placeholder={img?.globalAvailable ? 'Optional: this project’s own key (else uses the shared key)' : 'xAI API key (xai-…)'}
                    className="flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-gray-900 dark:text-gray-100"
                  />
                  <button onClick={connectImg} disabled={imgBusy || (!img?.globalAvailable && !imgKey.trim())}
                    className="text-sm px-4 py-2 rounded-lg bg-[#DE7356] text-white disabled:opacity-50 whitespace-nowrap">Connect</button>
                </div>
              )}
            </div>
          </div>

          <p className="text-xs text-gray-400 dark:text-gray-500 pt-2">
            Changes apply on the next preview start. A custom-container option is coming.
          </p>
        </div>
      )}
    </div>
  );
}
