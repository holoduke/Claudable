"use client";
import { useCallback, useEffect, useState } from 'react';
import { BACKEND_STACKS } from '@/lib/config/backend-stacks';
import { CONTAINER_TEMPLATES } from '@/lib/config/container-templates';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Container {
  kind: 'frontend' | 'backend' | 'database' | 'service';
  id?: string;          // managed-service id (generic containers)
  name: string;
  type: string;
  status: string;
  statusDetail?: string;
  url: string | null;
  description: string;
  removable: boolean;
  manageable?: boolean; // start/stop/restart/logs available
  icon?: string;
}

const KIND_ICON: Record<string, string> = { frontend: '🖥️', backend: '⚙️', database: '🗄️', service: '📦' };

function statusColor(s: string): string {
  if (s === 'running' || s === 'provisioned' || s === 'container') return 'bg-emerald-500';
  if (s === 'file') return 'bg-blue-400';
  return 'bg-gray-400';
}

export default function ContainersSettings({ projectId }: { projectId: string }) {
  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [addBackend, setAddBackend] = useState(false);
  const [addService, setAddService] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState({ name: '', image: '', alias: '', mountPath: '', env: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/containers`);
      const j = await r.json();
      setContainers((j?.data?.containers ?? j?.containers ?? []) as Container[]);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const add = async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/containers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      setAddBackend(false); setAddService(false); setCustomOpen(false);
      setCustom({ name: '', image: '', alias: '', mountPath: '', env: '' });
      await load();
    } finally { setBusy(false); }
  };
  const remove = async (c: Container) => {
    setBusy(true);
    try {
      const q = c.id ? `serviceId=${encodeURIComponent(c.id)}` : `kind=${c.kind}`;
      await fetch(`${API_BASE}/api/projects/${projectId}/containers?${q}`, { method: 'DELETE' });
      await load();
    } finally { setBusy(false); }
  };
  const action = async (id: string, act: 'start' | 'stop' | 'restart') => {
    setBusy(true);
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/containers/${encodeURIComponent(id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: act }),
      });
      await load();
    } finally { setBusy(false); }
  };
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logsText, setLogsText] = useState('');
  const viewLogs = async (id: string) => {
    setLogsFor(id); setLogsText('Loading…');
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/containers/${encodeURIComponent(id)}?tail=200`);
      const j = await r.json();
      setLogsText((j?.data?.logs ?? j?.logs ?? '(no logs)') as string);
    } catch { setLogsText('Failed to load logs.'); }
  };
  const addCustom = () => {
    const env: Record<string, string> = {};
    for (const line of custom.env.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    void add({ custom: {
      name: custom.name.trim() || custom.image.trim(),
      image: custom.image.trim(),
      alias: custom.alias.trim() || undefined,
      mountPath: custom.mountPath.trim() || undefined,
      env: Object.keys(env).length ? env : undefined,
    } });
  };

  const hasBackend = containers.some((c) => c.kind === 'backend');

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
            <div key={c.id || c.kind} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <span className="text-xl leading-none mt-0.5" aria-hidden>{c.icon || KIND_ICON[c.kind]}</span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{c.name}</span>
                      <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">{c.type}</span>
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                        <span className={`w-2 h-2 rounded-full ${statusColor(c.status)}`} />{c.status}
                      </span>
                    </div>
                    {c.url && (
                      /^https?:\/\//.test(c.url)
                        ? <a href={c.url} target="_blank" rel="noreferrer" className="text-xs text-[#DE7356] break-all mt-1 inline-block">{c.url}</a>
                        : <div className="text-xs font-mono text-gray-500 dark:text-gray-400 mt-1">{c.url}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {c.manageable && c.id && (
                    <>
                      {c.status === 'running' ? (
                        <button onClick={() => action(c.id!, 'stop')} disabled={busy}
                          className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-50">Stop</button>
                      ) : (
                        <button onClick={() => action(c.id!, 'start')} disabled={busy}
                          className="text-xs text-emerald-600 hover:text-emerald-700 disabled:opacity-50">Start</button>
                      )}
                      <button onClick={() => action(c.id!, 'restart')} disabled={busy}
                        className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-50">Restart</button>
                      <button onClick={() => viewLogs(c.id!)} disabled={busy}
                        className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-50">Logs</button>
                    </>
                  )}
                  {c.removable && (
                    <button onClick={() => remove(c)} disabled={busy}
                      className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50">Remove</button>
                  )}
                </div>
              </div>
            </div>
          ))}

          {/* Logs modal */}
          {logsFor && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setLogsFor(null)}>
              <div className="w-full max-w-3xl rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 dark:border-gray-800">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Logs · {logsFor}</span>
                  <div className="flex items-center gap-3">
                    <button onClick={() => viewLogs(logsFor)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Refresh</button>
                    <button onClick={() => setLogsFor(null)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Close</button>
                  </div>
                </div>
                <pre className="text-[11px] font-mono text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-950 p-3 max-h-[60vh] overflow-auto whitespace-pre-wrap">{logsText}</pre>
              </div>
            </div>
          )}

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
            <div className="relative">
              <button onClick={() => { setAddService(v => !v); setCustomOpen(false); }} disabled={busy}
                className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200 disabled:opacity-50">
                + Add container
              </button>
              {addService && (
                <div className="absolute z-20 mt-1 w-80 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg p-1">
                  {CONTAINER_TEMPLATES.map(t => (
                    <button key={t.id} onClick={() => add({ templateId: t.id })}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-50">{t.icon ? `${t.icon} ` : ''}{t.name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{t.description}</div>
                    </button>
                  ))}
                  <button onClick={() => { setCustomOpen(true); setAddService(false); }}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 border-t border-gray-100 dark:border-gray-800 mt-1">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-50">📦 Custom container…</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Any Docker image, on this project’s private network.</div>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Custom container form */}
          {customOpen && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4 space-y-2">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Custom container</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input value={custom.image} onChange={(e) => setCustom(s => ({ ...s, image: e.target.value }))}
                  placeholder="Image (e.g. redis:7-alpine)" className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-gray-900 dark:text-gray-100" />
                <input value={custom.name} onChange={(e) => setCustom(s => ({ ...s, name: e.target.value }))}
                  placeholder="Name (optional)" className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-gray-900 dark:text-gray-100" />
                <input value={custom.alias} onChange={(e) => setCustom(s => ({ ...s, alias: e.target.value }))}
                  placeholder="Network alias (e.g. cache)" className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-gray-900 dark:text-gray-100" />
                <input value={custom.mountPath} onChange={(e) => setCustom(s => ({ ...s, mountPath: e.target.value }))}
                  placeholder="Volume mount path (optional)" className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-gray-900 dark:text-gray-100" />
              </div>
              <textarea value={custom.env} onChange={(e) => setCustom(s => ({ ...s, env: e.target.value }))}
                placeholder="Env (one KEY=value per line)" rows={2}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent text-gray-900 dark:text-gray-100 font-mono" />
              <div className="flex gap-2">
                <button onClick={addCustom} disabled={busy || !custom.image.trim()}
                  className="text-sm px-4 py-2 rounded-lg bg-[#DE7356] text-white disabled:opacity-50">Add</button>
                <button onClick={() => setCustomOpen(false)} className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300">Cancel</button>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500">No host port is published — reachable only by this project’s other containers at its alias.</p>
            </div>
          )}
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
            Changes apply on the next preview start. Each container runs on this project’s private network — no host port, reachable only by this project.
          </p>
        </div>
      )}
    </div>
  );
}
