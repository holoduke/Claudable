"use client";

/**
 * Design Explorer board — a Claude-Design-style canvas. A brief fans out into
 * several standalone HTML mockups, rendered live side-by-side in sandboxed
 * iframes. Refine any one, or "Use this" to port it into the project (via the
 * parent's onApply → act pipeline). Frame progress is polled while any frame is
 * still generating (the backend also publishes design_frame SSE events).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
}
interface Canvas {
  id: string;
  title: string;
  prompt: string;
  status: string;
  frames: Frame[];
}

interface Props {
  projectId: string;
  /** Feed a port prompt to the agent (parent runs it through act + switches to preview). */
  onApply: (prompt: string) => void;
  /** An agent turn is running — block Use (it would launch another). */
  busy?: boolean;
}

export default function DesignExplorerBoard({ projectId, onApply, busy }: Props) {
  const t = useT();
  const [brief, setBrief] = useState('');
  const [count, setCount] = useState(3);
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [starting, setStarting] = useState(false);
  const [html, setHtml] = useState<Record<string, string>>({});
  const [refiningId, setRefiningId] = useState<string | null>(null);
  const [refineText, setRefineText] = useState('');
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load the most recent canvas on mount so a returning user sees their board.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/projects/${projectId}/design-explorer`, { credentials: 'include' });
        if (!r.ok) return;
        const j = await r.json();
        const list: Canvas[] = j?.data ?? [];
        if (!cancelled && list.length > 0) setCanvas(list[0]);
      } catch { /* offline / none */ }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const refreshCanvas = useCallback(async (canvasId: string) => {
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/design-explorer/${canvasId}`, { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      if (j?.data) setCanvas(j.data as Canvas);
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
        setHtml((h) => ({ ...h, [f.id]: '' })); // mark in-flight
        fetch(`${API_BASE}/api/projects/${projectId}/design-explorer/frames/${f.id}/html`, { credentials: 'include' })
          .then((r) => (r.ok ? r.text() : Promise.reject()))
          .then((text) => setHtml((h) => ({ ...h, [f.id]: text })))
          .catch(() => setHtml((h) => { const c = { ...h }; delete c[f.id]; return c; }));
      }
    }
  }, [canvas, html, projectId]);

  // Escape closes fullscreen.
  useEffect(() => {
    if (!fullscreenId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreenId(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreenId]);

  const generate = useCallback(async () => {
    const prompt = brief.trim();
    if (!prompt || starting) return;
    setStarting(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/design-explorer/generate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, count }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.data) { setError(j?.message || j?.error || 'Failed to start'); return; }
      setHtml({});
      setCanvas(j.data as Canvas);
    } catch {
      setError('Failed to start generation');
    } finally {
      setStarting(false);
    }
  }, [brief, count, starting, projectId]);

  const refine = useCallback(async (frameId: string) => {
    const prompt = refineText.trim();
    if (!prompt) return;
    setRefiningId(null);
    setRefineText('');
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/design-explorer/frames/${frameId}/refine`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (canvas) refreshCanvas(canvas.id);
    } catch { /* surfaced on next poll */ }
  }, [refineText, projectId, canvas, refreshCanvas]);

  const use = useCallback(async (frameId: string) => {
    if (!canvas || busy) return;
    setApplyingId(frameId);
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/design-explorer/${canvas.id}/apply`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frameId }),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.data?.suggestedPrompt) onApply(j.data.suggestedPrompt as string);
    } catch { /* ignore */ } finally {
      setApplyingId(null);
    }
  }, [canvas, busy, projectId, onApply]);

  const frames = canvas?.frames ?? [];
  const fullscreenFrame = frames.find((f) => f.id === fullscreenId);

  return (
    <div className="w-full h-full overflow-y-auto bg-gray-50 dark:bg-[#0c0a09] p-4">
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
            <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              {t('designExplorer.variations')}
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="bg-transparent border border-gray-200 dark:border-white/10 rounded-md px-1.5 py-0.5 text-gray-900 dark:text-gray-100"
              >
                {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n} className="dark:bg-[#181310]">{n}</option>)}
              </select>
              <span className="hidden sm:inline text-gray-400 dark:text-gray-500">· {t('designExplorer.costHint')}</span>
            </label>
            <button
              onClick={generate}
              disabled={!brief.trim() || starting}
              className="px-4 py-1.5 bg-[#DE7356] text-white rounded-lg text-sm font-medium hover:bg-[#c9634a] disabled:opacity-40 flex items-center gap-2"
            >
              {starting && <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />}
              {starting ? t('designExplorer.generating') : t('designExplorer.generate')}
            </button>
          </div>
        </div>
        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      </div>

      {/* Board */}
      {frames.length === 0 ? (
        <div className="max-w-md mx-auto mt-16 text-center">
          <div className="text-4xl mb-3">🎨</div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-50">{t('designExplorer.emptyTitle')}</h3>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{t('designExplorer.emptyBody')}</p>
        </div>
      ) : (
        <div className="max-w-6xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {frames.map((f) => (
            <div key={f.id} className="group rounded-xl border border-gray-200 dark:border-white/8 bg-white dark:bg-white/3 overflow-hidden">
              <div className="aspect-4/3 relative bg-gray-100 dark:bg-gray-900 overflow-hidden">
                {f.status === 'ready' && html[f.id] ? (
                  <iframe
                    title={f.styleName || 'design'}
                    srcDoc={html[f.id]}
                    sandbox="allow-scripts"
                    className="absolute inset-0 w-full h-full border-0 bg-white"
                    // Scale the 1280px design down into the small tile.
                    style={{ width: '1280px', height: '960px', transform: 'scale(0.32)', transformOrigin: 'top left' }}
                  />
                ) : f.status === 'error' ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-3 gap-2">
                    <span className="text-xs text-red-500">{t('designExplorer.failed')}</span>
                    <button onClick={() => { setRefiningId(f.id); setRefineText('regenerate'); }} className="text-xs text-[#DE7356] hover:underline">{t('designExplorer.retry')}</button>
                  </div>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-linear-to-br from-[#DE7356]/8 via-gray-50 to-[#DE7356]/5 dark:from-[#DE7356]/12 dark:via-gray-900 dark:to-gray-950">
                    <span className="w-6 h-6 rounded-full border-2 border-gray-300 dark:border-white/8 border-t-[#DE7356] animate-spin" />
                    <span className="text-xs text-gray-500 dark:text-gray-400">{f.status === 'generating' ? t('designExplorer.working') : t('designExplorer.pending')}</span>
                  </div>
                )}
                {/* click-catcher to open fullscreen when ready */}
                {f.status === 'ready' && html[f.id] && (
                  <button aria-label={t('designExplorer.fullscreen')} onClick={() => setFullscreenId(f.id)} className="absolute inset-0 w-full h-full cursor-zoom-in" />
                )}
              </div>
              <div className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-gray-700 dark:text-gray-200 truncate">{f.styleName || '—'}{f.version > 1 ? ` · v${f.version}` : ''}</span>
                </div>
                {refiningId === f.id ? (
                  <div className="mt-2 flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={refineText}
                      onChange={(e) => setRefineText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') refine(f.id); if (e.key === 'Escape') setRefiningId(null); }}
                      placeholder={t('designExplorer.refinePlaceholder')}
                      className="flex-1 min-w-0 text-xs bg-transparent border border-gray-200 dark:border-white/10 rounded-md px-2 py-1 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-[#DE7356] focus:outline-none"
                    />
                    <button onClick={() => refine(f.id)} className="text-xs px-2 py-1 bg-[#DE7356] text-white rounded-md hover:bg-[#c9634a]">↵</button>
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-1.5">
                    <button
                      onClick={() => use(f.id)}
                      disabled={f.status !== 'ready' || busy || applyingId === f.id}
                      className="flex-1 text-xs px-2 py-1 bg-[#DE7356] text-white rounded-md hover:bg-[#c9634a] disabled:opacity-40"
                    >
                      {applyingId === f.id ? '…' : t('designExplorer.use')}
                    </button>
                    <button
                      onClick={() => { setRefiningId(f.id); setRefineText(''); }}
                      disabled={f.status !== 'ready'}
                      className="text-xs px-2 py-1 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 border border-gray-200 dark:border-white/10 rounded-md disabled:opacity-40"
                    >
                      {t('designExplorer.refine')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Fullscreen preview */}
      {fullscreenFrame && html[fullscreenFrame.id] && (
        <div className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6" onClick={() => setFullscreenId(null)}>
          <div className="relative bg-white rounded-lg shadow-2xl w-full max-w-5xl h-[85vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <iframe title="design-fullscreen" srcDoc={html[fullscreenFrame.id]} sandbox="allow-scripts" className="w-full h-full border-0" />
            <div className="absolute top-2 right-2 flex gap-2">
              <button
                onClick={() => { void use(fullscreenFrame.id); setFullscreenId(null); }}
                disabled={busy}
                className="px-3 py-1.5 bg-[#DE7356] text-white rounded-lg text-sm font-medium hover:bg-[#c9634a] disabled:opacity-40 shadow"
              >
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
