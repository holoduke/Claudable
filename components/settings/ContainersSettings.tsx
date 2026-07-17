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
  if (s === 'file') return 'bg-brand-500';
  if (s === 'starting' || s === 'restarting' || s === 'created') return 'bg-amber-500';
  return 'bg-gray-400';
}
// Container is up or on its way up → the action to offer is Stop (not Start).
function isUpish(s: string): boolean {
  return s === 'running' || s === 'provisioned' || s === 'container' || s === 'starting' || s === 'restarting';
}

export default function ContainersSettings({ projectId }: { projectId: string }) {
  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [addBackend, setAddBackend] = useState(false);
  const [addService, setAddService] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState({ name: '', image: '', alias: '', mountPath: '', env: '' });
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/containers`);
      const j = await r.json();
      setContainers((j?.data?.containers ?? j?.containers ?? []) as Container[]);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // Surface the API's error text (so a failed add/action isn't silent).
  const errText = async (r: Response): Promise<string> => {
    try { const j = await r.json(); return j?.error || j?.message || `Request failed (${r.status})`; }
    catch { return `Request failed (${r.status})`; }
  };

  // Returns true on success. On failure sets `error` and leaves the caller's UI
  // (menu / form input) untouched so the user can see what went wrong and retry.
  const add = async (payload: Record<string, unknown>): Promise<boolean> => {
    setBusy(true); setError('');
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/containers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!r.ok) { setError(await errText(r)); return false; }
      setAddBackend(false); setAddService(false); setCustomOpen(false);
      setCustom({ name: '', image: '', alias: '', mountPath: '', env: '' });
      await load();
      return true;
    } catch (e) { setError((e as Error).message || 'Network error'); return false; }
    finally { setBusy(false); }
  };
  const remove = async (c: Container) => {
    const warn = c.kind === 'database'
      ? `Remove the ${c.name} container? Its data volume is deleted too — this can't be undone.`
      : `Remove the ${c.name} container?`;
    if (!window.confirm(warn)) return;
    setBusy(true); setError('');
    try {
      const q = c.id ? `serviceId=${encodeURIComponent(c.id)}` : `kind=${c.kind}`;
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/containers?${q}`, { method: 'DELETE' });
      if (!r.ok) { setError(await errText(r)); return; }
      await load();
    } catch (e) { setError((e as Error).message || 'Network error'); }
    finally { setBusy(false); }
  };
  const action = async (id: string, act: 'start' | 'stop' | 'restart') => {
    setBusy(true); setError('');
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/containers/${encodeURIComponent(id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: act }),
      });
      if (!r.ok) { setError(`Could not ${act} container: ${await errText(r)}`); }
      await load();
    } catch (e) { setError((e as Error).message || 'Network error'); }
    finally { setBusy(false); }
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
    setImgBusy(true); setError('');
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/image-capability`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imgKey.trim() ? { apiKey: imgKey.trim() } : {}),
      });
      if (!r.ok) { setError(`Could not connect image generation: ${await errText(r)}`); return; }
      setImgKey(''); await loadImg();
    } catch (e) { setError((e as Error).message || 'Network error'); }
    finally { setImgBusy(false); }
  };
  const disconnectImg = async () => {
    setImgBusy(true); setError('');
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/image-capability`, { method: 'DELETE' });
      if (!r.ok) { setError(await errText(r)); return; }
      await loadImg();
    } catch (e) { setError((e as Error).message || 'Network error'); }
    finally { setImgBusy(false); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Containers</h3>
        <button onClick={load} disabled={busy || loading}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-white/8 hover:bg-gray-50 dark:hover:bg-white/6 disabled:opacity-50">Refresh</button>
      </div>

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
          <span className="wrap-break-word min-w-0">{error}</span>
          <button onClick={() => setError('')} className="shrink-0 hover:text-red-800 dark:hover:text-red-300">✕</button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      ) : (
        <div className="space-y-3">
          {containers.map((c) => (
            <div key={c.id || c.kind} className="rounded-xl border border-gray-200 dark:border-white/8 bg-white dark:bg-white/3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <span className="text-xl leading-none mt-0.5" aria-hidden>{c.icon || KIND_ICON[c.kind]}</span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{c.name}</span>
                      <span className="text-[11px] font-mono px-1.5 py-0.5 rounded-sm bg-gray-100 dark:bg-white/6 text-gray-500 dark:text-gray-400">{c.type}</span>
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                        <span className={`w-2 h-2 rounded-full ${statusColor(c.status)}`} />{c.status}
                      </span>
                    </div>
                    {c.url && (
                      /^https?:\/\//.test(c.url)
                        ? <a href={c.url} target="_blank" rel="noreferrer" className="text-xs text-brand-500 break-all mt-1 inline-block">{c.url}</a>
                        : <div className="text-xs font-mono text-gray-500 dark:text-gray-400 mt-1">{c.url}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {c.manageable && c.id && (
                    <>
                      {isUpish(c.status) ? (
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
              <div className="w-full max-w-3xl rounded-xl bg-white dark:bg-[#181310] border border-gray-200 dark:border-white/10 shadow-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 dark:border-white/8">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Logs · {logsFor}</span>
                  <div className="flex items-center gap-3">
                    <button onClick={() => viewLogs(logsFor)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Refresh</button>
                    <button onClick={() => setLogsFor(null)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Close</button>
                  </div>
                </div>
                <pre className="text-[11px] font-mono text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-white/6 p-3 max-h-[60vh] overflow-auto whitespace-pre-wrap">{logsText}</pre>
              </div>
            </div>
          )}

          {/* Add actions */}
          <div className="flex flex-wrap gap-2 pt-1">
            {!hasBackend && (
              <div className="relative">
                <button onClick={() => setAddBackend(v => !v)} disabled={busy}
                  className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 hover:bg-gray-50 dark:hover:bg-white/6 text-gray-700 dark:text-gray-200 disabled:opacity-50">
                  + Add backend
                </button>
                {addBackend && (
                  <div className="absolute z-20 mt-1 w-72 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#181310] shadow-lg p-1">
                    {BACKEND_STACKS.map(b => (
                      <button key={b.id} onClick={() => add({ backendId: b.id })} disabled={busy}
                        className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-white/6 disabled:opacity-50">
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
                className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 hover:bg-gray-50 dark:hover:bg-white/6 text-gray-700 dark:text-gray-200 disabled:opacity-50">
                + Add container
              </button>
              {addService && (
                <div className="absolute z-20 mt-1 w-80 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#181310] shadow-lg p-1">
                  {CONTAINER_TEMPLATES.map(t => (
                    <button key={t.id} onClick={() => add({ templateId: t.id })} disabled={busy}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-white/6 disabled:opacity-50">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-50">{t.icon ? `${t.icon} ` : ''}{t.name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{t.description}</div>
                    </button>
                  ))}
                  <button onClick={() => { setCustomOpen(true); setAddService(false); }}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-white/6 border-t border-gray-100 dark:border-white/8 mt-1">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-50">📦 Custom container…</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Any Docker image, on this project’s private network.</div>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Custom container form */}
          {customOpen && (
            <div className="rounded-xl border border-gray-200 dark:border-white/8 bg-gray-50 dark:bg-white/3 p-4 space-y-2">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Custom container</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input value={custom.image} onChange={(e) => setCustom(s => ({ ...s, image: e.target.value }))}
                  placeholder="Image (e.g. redis:7-alpine)" className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-transparent text-gray-900 dark:text-gray-100" />
                <input value={custom.name} onChange={(e) => setCustom(s => ({ ...s, name: e.target.value }))}
                  placeholder="Name (optional)" className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-transparent text-gray-900 dark:text-gray-100" />
                <input value={custom.alias} onChange={(e) => setCustom(s => ({ ...s, alias: e.target.value }))}
                  placeholder="Network alias (e.g. cache)" className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-transparent text-gray-900 dark:text-gray-100" />
                <input value={custom.mountPath} onChange={(e) => setCustom(s => ({ ...s, mountPath: e.target.value }))}
                  placeholder="Volume mount path (optional)" className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-transparent text-gray-900 dark:text-gray-100" />
              </div>
              <textarea value={custom.env} onChange={(e) => setCustom(s => ({ ...s, env: e.target.value }))}
                placeholder="Env (one KEY=value per line)" rows={2}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-transparent text-gray-900 dark:text-gray-100 font-mono" />
              <div className="flex gap-2">
                <button onClick={addCustom} disabled={busy || !custom.image.trim()}
                  className="text-sm px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white disabled:opacity-50">Add</button>
                <button onClick={() => setCustomOpen(false)} className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 text-gray-600 dark:text-gray-300">Cancel</button>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500">No host port is published — reachable only by this project’s other containers at its alias.</p>
            </div>
          )}
          {/* Capabilities — shared services a project connects to */}
          <div className="pt-4 mt-2 border-t border-gray-100 dark:border-white/8">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">Capabilities</h4>
            <div className="rounded-xl border border-gray-200 dark:border-white/8 bg-white dark:bg-white/3 p-4">
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
                    className="flex-1 text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-white/8 bg-transparent text-gray-900 dark:text-gray-100"
                  />
                  <button onClick={connectImg} disabled={imgBusy || (!img?.globalAvailable && !imgKey.trim())}
                    className="text-sm px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white disabled:opacity-50 whitespace-nowrap">Connect</button>
                </div>
              )}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
