"use client";

/**
 * Design Explorer board — a Claude-Design-style canvas. A brief fans out into
 * several standalone HTML mockups, rendered live side-by-side in sandboxed
 * iframes. Refine/regenerate any one (refinements are kept as VERSIONS of the
 * same lineage, so a card shows the latest with a ‹ › version stepper), add
 * more variations, switch between past explorations, and "Use this" to port a
 * design into the project. Progress is polled while frames generate (the
 * backend also publishes design_frame SSE events).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/contexts/I18nContext';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Frame {
  id: string;
  canvasId: string;
  styleId: string | null;
  styleName: string | null;
  status: string; // pending | generating | ready | error
  errorText: string | null;
  version: number;
  parentFrameId: string | null;
  hasHtml: boolean;
  costUsd: number | null;
  durationMs: number | null;
}
interface Canvas {
  id: string;
  title: string;
  prompt: string;
  status: string;
  hasReference?: boolean;
  createdAt?: string;
  frames: Frame[];
}

interface Props {
  projectId: string;
  onApply: (prompt: string) => void;
  busy?: boolean;
}

const REGEN_PROMPT = 'Regenerate: produce a fresh alternative take in the same overall direction.';

export default function DesignExplorerBoard({ projectId, onApply, busy }: Props) {
  const t = useT();
  const [brief, setBrief] = useState('');
  const [count, setCount] = useState(3);
  const [canvases, setCanvases] = useState<Canvas[]>([]);
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [starting, setStarting] = useState(false);
  const [addingMore, setAddingMore] = useState(false);
  const [html, setHtml] = useState<Record<string, string>>({});
  const [refiningId, setRefiningId] = useState<string | null>(null);
  const [refineText, setRefineText] = useState('');
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [versionIdx, setVersionIdx] = useState<Record<string, number>>({});
  const [refImage, setRefImage] = useState<string | null>(null); // data URL
  const [combineMode, setCombineMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [combining, setCombining] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Total agent cost of the current canvas (sum of frame cost, when reported).
  const totalCost = (canvas?.frames ?? []).reduce((sum, f) => sum + (f.costUsd ?? 0), 0);

  const loadList = useCallback(async (selectFirst = false) => {
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/design-explorer`, { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      const list: Canvas[] = j?.data ?? [];
      setCanvases(list);
      if (selectFirst && list.length > 0) setCanvas(list[0]);
    } catch { /* offline / none */ }
  }, [projectId]);

  useEffect(() => { void loadList(true); }, [loadList]);

  const refreshCanvas = useCallback(async (canvasId: string) => {
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/design-explorer/${canvasId}`, { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      if (j?.data) {
        setCanvas(j.data as Canvas);
        setCanvases((cs) => cs.map((c) => (c.id === canvasId ? { ...c, ...(j.data as Canvas) } : c)));
      }
    } catch { /* transient */ }
  }, [projectId]);

  // Poll while any frame is still working.
  useEffect(() => {
    const working = canvas?.frames.some((f) => f.status === 'pending' || f.status === 'generating');
    if (canvas && working) {
      pollRef.current = setInterval(() => refreshCanvas(canvas.id), 3000);
      return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, [canvas, refreshCanvas]);

  // Fetch mockup HTML for ready frames we haven't loaded yet.
  useEffect(() => {
    if (!canvas) return;
    for (const f of canvas.frames) {
      if (f.status === 'ready' && f.hasHtml && html[f.id] === undefined) {
        setHtml((h) => ({ ...h, [f.id]: '' }));
        fetch(`${API_BASE}/api/projects/${projectId}/design-explorer/frames/${f.id}/html`, { credentials: 'include' })
          .then((r) => (r.ok ? r.text() : Promise.reject()))
          .then((text) => setHtml((h) => ({ ...h, [f.id]: text })))
          .catch(() => setHtml((h) => { const c = { ...h }; delete c[f.id]; return c; }));
      }
    }
  }, [canvas, html, projectId]);

  useEffect(() => {
    if (!fullscreenId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreenId(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreenId]);

  // Collapse refinement lineages: group frames by their root (walk parentFrameId
  // up), order each group by version, and show one card per lineage.
  const lineages = useMemo(() => {
    const frames = canvas?.frames ?? [];
    const byId = new Map(frames.map((f) => [f.id, f]));
    const rootOf = (f: Frame): string => {
      let cur = f;
      const seen = new Set<string>();
      while (cur.parentFrameId && byId.has(cur.parentFrameId) && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.parentFrameId)!;
      }
      return cur.id;
    };
    const groups = new Map<string, Frame[]>();
    for (const f of frames) {
      const root = rootOf(f);
      const arr = groups.get(root) ?? [];
      arr.push(f);
      groups.set(root, arr);
    }
    // Preserve original (creation) order of roots; sort each lineage by version.
    const order: string[] = [];
    for (const f of frames) { const r = rootOf(f); if (!order.includes(r)) order.push(r); }
    return order.map((root) => ({ root, versions: (groups.get(root) ?? []).slice().sort((a, b) => a.version - b.version) }));
  }, [canvas]);

  const generate = useCallback(async () => {
    const prompt = brief.trim();
    if (!prompt || starting) return;
    setStarting(true); setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/design-explorer/generate`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, count, referenceImage: refImage || undefined }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.data) { setError(j?.message || j?.error || 'Failed to start'); return; }
      setHtml({}); setVersionIdx({}); setRefImage(null);
      setCanvas(j.data as Canvas);
      setCanvases((cs) => [j.data as Canvas, ...cs]);
    } catch { setError('Failed to start generation'); } finally { setStarting(false); }
  }, [brief, count, starting, projectId]);

  const addMore = useCallback(async () => {
    if (!canvas || addingMore) return;
    setAddingMore(true);
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/design-explorer/${canvas.id}/frames`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 2 }),
      });
      await refreshCanvas(canvas.id);
    } catch { /* ignore */ } finally { setAddingMore(false); }
  }, [canvas, addingMore, projectId, refreshCanvas]);

  const deleteCanvas = useCallback(async () => {
    if (!canvas || !window.confirm(t('designExplorer.confirmDelete'))) return;
    const id = canvas.id;
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/design-explorer/${id}`, { method: 'DELETE', credentials: 'include' });
    } catch { /* ignore */ }
    setCanvases((cs) => {
      const next = cs.filter((c) => c.id !== id);
      setCanvas(next[0] ?? null);
      return next;
    });
  }, [canvas, projectId, t]);

  const refineFrame = useCallback(async (frameId: string, prompt: string) => {
    if (!prompt.trim()) return;
    setRefiningId(null); setRefineText('');
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/design-explorer/frames/${frameId}/refine`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (canvas) refreshCanvas(canvas.id);
    } catch { /* surfaced on next poll */ }
  }, [projectId, canvas, refreshCanvas]);

  const use = useCallback(async (frameId: string) => {
    if (!canvas || busy) return;
    setApplyingId(frameId);
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/design-explorer/${canvas.id}/apply`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frameId }),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.data?.suggestedPrompt) onApply(j.data.suggestedPrompt as string);
    } catch { /* ignore */ } finally { setApplyingId(null); }
  }, [canvas, busy, projectId, onApply]);

  const onPickImage = useCallback((file: File | null) => {
    if (!file) { setRefImage(null); return; }
    if (file.size > 8 * 1024 * 1024) { setError('Reference image is too large (max 8MB)'); return; }
    const reader = new FileReader();
    reader.onload = () => setRefImage(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(file);
  }, []);

  const toggleSelect = useCallback((frameId: string) => {
    setSelected((s) => (s.includes(frameId) ? s.filter((x) => x !== frameId) : [...s, frameId].slice(-2)));
  }, []);

  const combine = useCallback(async () => {
    if (!canvas || selected.length !== 2 || combining) return;
    setCombining(true);
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/design-explorer/${canvas.id}/combine`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frameIds: selected }),
      });
      setSelected([]); setCombineMode(false);
      await refreshCanvas(canvas.id);
    } catch { /* ignore */ } finally { setCombining(false); }
  }, [canvas, selected, combining, projectId, refreshCanvas]);

  const exportHtml = useCallback((frame: Frame) => {
    const content = html[frame.id];
    if (!content) return;
    const blob = new Blob([content], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(frame.styleName || 'design').toLowerCase().replace(/[^a-z0-9-]+/g, '-')}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [html]);

  const iframeStyle = device === 'mobile'
    ? { width: '390px', height: '1400px', transform: 'scale(0.82)', transformOrigin: 'top center' as const }
    : { width: '1280px', height: '1600px', transform: 'scale(0.28)', transformOrigin: 'top left' as const };

  const fullscreenFrame = lineages.flatMap((l) => l.versions).find((f) => f.id === fullscreenId);

  return (
    <div className="w-full h-full overflow-y-auto bg-gray-50 dark:bg-[#0c0a09]">
      {/* Toolbar: history switcher + new + device */}
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-white/8 bg-gray-50/90 dark:bg-[#0c0a09]/90 backdrop-blur">
        <select
          value={canvas?.id ?? ''}
          onChange={(e) => { const c = canvases.find((x) => x.id === e.target.value); if (c) { setHtml({}); setVersionIdx({}); void refreshCanvas(c.id); } }}
          className="max-w-[40%] truncate bg-transparent border border-gray-200 dark:border-white/10 rounded-md px-2 py-1 text-xs text-gray-700 dark:text-gray-200"
        >
          {canvases.length === 0 && <option value="">{t('designExplorer.history')}</option>}
          {canvases.map((c) => <option key={c.id} value={c.id} className="dark:bg-[#181310]">{c.title || t('designExplorer.title')}</option>)}
        </select>
        <button onClick={() => { setCanvas(null); setError(null); }} className="text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100">
          + {t('designExplorer.new')}
        </button>
        {canvas && (
          <button onClick={deleteCanvas} title={t('designExplorer.deleteCanvas')} className="text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-white/10 text-gray-500 hover:text-red-500">
            🗑
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {totalCost > 0 && (
            <span className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums" title={t('designExplorer.totalCost')}>
              {t('designExplorer.totalCost')} ${totalCost.toFixed(2)}
            </span>
          )}
          {canvas && (canvas.frames?.length ?? 0) >= 2 && (
            <button
              onClick={() => { setCombineMode((v) => !v); setSelected([]); }}
              className={`text-xs px-2 py-1 rounded-md border ${combineMode ? 'border-[#DE7356] text-[#DE7356]' : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300'}`}
            >
              {t('designExplorer.combine')}
            </button>
          )}
          <div className="flex items-center bg-gray-100 dark:bg-white/6 rounded-md p-0.5">
            {(['desktop', 'mobile'] as const).map((d) => (
              <button key={d} onClick={() => setDevice(d)} className={`text-xs px-2 py-0.5 rounded ${device === d ? 'bg-white dark:bg-white/12 text-gray-900 dark:text-gray-50' : 'text-gray-500 dark:text-gray-400'}`}>
                {t(d === 'desktop' ? 'designExplorer.desktop' : 'designExplorer.mobile')}
              </button>
            ))}
          </div>
        </div>
      </div>
      {/* Combine hint / action bar */}
      {combineMode && (
        <div className="sticky top-[41px] z-10 flex items-center justify-between px-4 py-1.5 bg-[#DE7356]/10 text-[#DE7356] text-xs">
          <span>{t('designExplorer.combineSelect')} ({selected.length}/2)</span>
          <button onClick={combine} disabled={selected.length !== 2 || combining} className="px-3 py-1 bg-[#DE7356] text-white rounded-md disabled:opacity-40">
            {combining ? '…' : t('designExplorer.combine')}
          </button>
        </div>
      )}

      <div className="p-4">
        {/* Brief bar */}
        <div className="max-w-4xl mx-auto mb-4">
          <div className="flex flex-col gap-2 p-3 rounded-2xl border border-gray-200 dark:border-white/8 bg-white dark:bg-white/4">
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); generate(); } }}
              placeholder={t('designExplorer.briefPlaceholder')}
              rows={2}
              className="w-full resize-none bg-transparent text-sm text-gray-900 dark:text-gray-50 placeholder:text-gray-400 focus:outline-none"
            />
            <div className="flex items-center justify-between gap-3">
              {refImage ? (
                <span className="relative inline-flex shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={refImage} alt="" className="w-8 h-8 rounded object-cover border border-gray-200 dark:border-white/10" />
                  <button onClick={() => setRefImage(null)} title={t('designExplorer.removeImage')} className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-gray-700 text-white rounded-full text-[10px] leading-none">×</button>
                </span>
              ) : (
                <label className="shrink-0 text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-white/10 text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-800 dark:hover:text-gray-100">
                  🖼 {t('designExplorer.attachImage')}
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => onPickImage(e.target.files?.[0] ?? null)} />
                </label>
              )}
              <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                {t('designExplorer.variations')}
                <select value={count} onChange={(e) => setCount(Number(e.target.value))} className="bg-transparent border border-gray-200 dark:border-white/10 rounded-md px-1.5 py-0.5 text-gray-900 dark:text-gray-100">
                  {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n} className="dark:bg-[#181310]">{n}</option>)}
                </select>
                <span className="hidden sm:inline text-gray-400 dark:text-gray-500">· {t('designExplorer.costHint')}</span>
              </label>
              <button onClick={generate} disabled={!brief.trim() || starting} className="px-4 py-1.5 bg-[#DE7356] text-white rounded-lg text-sm font-medium hover:bg-[#c9634a] disabled:opacity-40 flex items-center gap-2">
                {starting && <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />}
                {starting ? t('designExplorer.generating') : t('designExplorer.generate')}
              </button>
            </div>
          </div>
          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        </div>

        {/* Board */}
        {lineages.length === 0 ? (
          <div className="max-w-md mx-auto mt-16 text-center">
            <div className="text-4xl mb-3">🎨</div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-50">{t('designExplorer.emptyTitle')}</h3>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{t('designExplorer.emptyBody')}</p>
          </div>
        ) : (
          <div className="max-w-6xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {lineages.map(({ root, versions }) => {
              const idx = Math.min(versionIdx[root] ?? versions.length - 1, versions.length - 1);
              const f = versions[idx];
              return (
                <div key={root} className={`group rounded-xl border bg-white dark:bg-white/3 overflow-hidden transition-colors ${selected.includes(f.id) ? 'ring-2 ring-[#DE7356] border-[#DE7356]' : 'border-gray-200 dark:border-white/8'}`}>
                  <div className="aspect-4/3 relative bg-gray-100 dark:bg-gray-900 overflow-hidden flex justify-center">
                    {f.status === 'ready' && html[f.id] ? (
                      <iframe title={f.styleName || 'design'} srcDoc={html[f.id]} sandbox="allow-scripts" className="border-0 bg-white" style={{ position: 'absolute', top: 0, ...iframeStyle }} />
                    ) : f.status === 'error' ? (
                      <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-3 gap-2">
                        <span className="text-xs text-red-500">{t('designExplorer.failed')}</span>
                        <button onClick={() => refineFrame(f.id, REGEN_PROMPT)} className="text-xs text-[#DE7356] hover:underline">{t('designExplorer.retry')}</button>
                      </div>
                    ) : (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-linear-to-br from-[#DE7356]/8 via-gray-50 to-[#DE7356]/5 dark:from-[#DE7356]/12 dark:via-gray-900 dark:to-gray-950">
                        <span className="w-6 h-6 rounded-full border-2 border-gray-300 dark:border-white/8 border-t-[#DE7356] animate-spin" />
                        <span className="text-xs text-gray-500 dark:text-gray-400">{f.status === 'generating' ? t('designExplorer.working') : t('designExplorer.pending')}</span>
                      </div>
                    )}
                    {f.status === 'ready' && html[f.id] && (
                      <button
                        aria-label={combineMode ? t('designExplorer.combine') : t('designExplorer.fullscreen')}
                        onClick={() => (combineMode ? toggleSelect(f.id) : setFullscreenId(f.id))}
                        className={`absolute inset-0 w-full h-full ${combineMode ? 'cursor-pointer' : 'cursor-zoom-in'}`}
                      />
                    )}
                    {combineMode && f.status === 'ready' && (
                      <span className={`absolute top-2 left-2 w-5 h-5 rounded-full border-2 flex items-center justify-center text-[10px] ${selected.includes(f.id) ? 'bg-[#DE7356] border-[#DE7356] text-white' : 'bg-white/80 border-gray-300'}`}>
                        {selected.includes(f.id) ? selected.indexOf(f.id) + 1 : ''}
                      </span>
                    )}
                  </div>
                  <div className="p-2.5">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-200 truncate">{f.styleName || '—'}</span>
                      {versions.length > 1 && (
                        <span className="flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500 shrink-0">
                          <button onClick={() => setVersionIdx((v) => ({ ...v, [root]: Math.max(0, idx - 1) }))} disabled={idx === 0} className="disabled:opacity-30">‹</button>
                          v{f.version}
                          <button onClick={() => setVersionIdx((v) => ({ ...v, [root]: Math.min(versions.length - 1, idx + 1) }))} disabled={idx === versions.length - 1} className="disabled:opacity-30">›</button>
                        </span>
                      )}
                    </div>
                    {refiningId === f.id ? (
                      <div className="flex items-center gap-1.5">
                        <input autoFocus value={refineText} onChange={(e) => setRefineText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') refineFrame(f.id, refineText); if (e.key === 'Escape') setRefiningId(null); }}
                          placeholder={t('designExplorer.refinePlaceholder')}
                          className="flex-1 min-w-0 text-xs bg-transparent border border-gray-200 dark:border-white/10 rounded-md px-2 py-1 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-[#DE7356] focus:outline-none" />
                        <button onClick={() => refineFrame(f.id, refineText)} className="text-xs px-2 py-1 bg-[#DE7356] text-white rounded-md hover:bg-[#c9634a]">↵</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => use(f.id)} disabled={f.status !== 'ready' || busy || applyingId === f.id} className="flex-1 text-xs px-2 py-1 bg-[#DE7356] text-white rounded-md hover:bg-[#c9634a] disabled:opacity-40">
                          {applyingId === f.id ? '…' : t('designExplorer.use')}
                        </button>
                        <button onClick={() => { setRefiningId(f.id); setRefineText(''); }} disabled={f.status !== 'ready'} className="text-xs px-2 py-1 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 border border-gray-200 dark:border-white/10 rounded-md disabled:opacity-40">
                          {t('designExplorer.refine')}
                        </button>
                        <button onClick={() => refineFrame(f.id, REGEN_PROMPT)} disabled={f.status !== 'ready'} title={t('designExplorer.regenerate')} className="text-xs px-2 py-1 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 border border-gray-200 dark:border-white/10 rounded-md disabled:opacity-40">
                          ↻
                        </button>
                        <button onClick={() => exportHtml(f)} disabled={f.status !== 'ready' || !html[f.id]} title={t('designExplorer.export')} className="text-xs px-2 py-1 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 border border-gray-200 dark:border-white/10 rounded-md disabled:opacity-40">
                          ↓
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Add more */}
            {canvas && (
              <button onClick={addMore} disabled={addingMore} className="rounded-xl border-2 border-dashed border-gray-200 dark:border-white/10 aspect-4/3 flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-gray-500 hover:border-[#DE7356]/40 hover:text-[#DE7356] transition-colors disabled:opacity-50">
                {addingMore ? <span className="w-5 h-5 rounded-full border-2 border-gray-300 dark:border-white/8 border-t-[#DE7356] animate-spin" /> : <span className="text-2xl">+</span>}
                <span className="text-xs">{t('designExplorer.addMore')}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Fullscreen */}
      {fullscreenFrame && html[fullscreenFrame.id] && (
        <div className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6" onClick={() => setFullscreenId(null)}>
          <div className={`relative bg-white rounded-lg shadow-2xl h-[85vh] overflow-hidden ${device === 'mobile' ? 'w-[390px]' : 'w-full max-w-5xl'}`} onClick={(e) => e.stopPropagation()}>
            <iframe title="design-fullscreen" srcDoc={html[fullscreenFrame.id]} sandbox="allow-scripts" className="w-full h-full border-0" />
            <div className="absolute top-2 right-2 flex gap-2">
              <button onClick={() => exportHtml(fullscreenFrame)} className="px-3 py-1.5 bg-white/90 text-gray-800 rounded-lg text-sm shadow" title={t('designExplorer.export')}>↓</button>
              <button onClick={() => { void use(fullscreenFrame.id); setFullscreenId(null); }} disabled={busy} className="px-3 py-1.5 bg-[#DE7356] text-white rounded-lg text-sm font-medium hover:bg-[#c9634a] disabled:opacity-40 shadow">
                {t('designExplorer.use')}
              </button>
              <button onClick={() => setFullscreenId(null)} className="px-3 py-1.5 bg-white/90 text-gray-800 rounded-lg text-sm shadow">✕</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
