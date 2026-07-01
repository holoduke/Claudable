"use client";
import { use, useCallback, useEffect, useRef, useState } from 'react';
import CommentsLayer, { type CommentPin, type ComposeAnchor } from '@/components/chat/CommentsLayer';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface ShareInfo { projectId: string; projectName: string; previewUrl: string | null }

/** Public stakeholder-review page: live preview + leave pinned comments as a guest. */
export default function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guestName, setGuestName] = useState<string>('');
  const [nameConfirmed, setNameConfirmed] = useState(false);
  const [route, setRoute] = useState('/');
  const [comments, setComments] = useState<CommentPin[]>([]);
  const [positions, setPositions] = useState<Record<string, { x: number | null; y: number | null }>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeAnchor | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const routeRef = useRef('/');
  routeRef.current = route;
  const commentsRef = useRef<CommentPin[]>([]);
  commentsRef.current = comments;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  // Restore a previously entered guest name.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('claudable-guest-name');
      if (saved) { setGuestName(saved); setNameConfirmed(true); }
    } catch { /* ignore */ }
  }, []);

  // Resolve the share link.
  useEffect(() => {
    fetch(`${API_BASE}/api/share/${token}`)
      .then((r) => r.json())
      .then((j) => { if (j.success) setInfo(j.data); else setError(j.error?.message || 'Invalid or revoked link'); })
      .catch(() => setError('Could not load this share link'));
  }, [token]);

  const post = useCallback((msg: Record<string, unknown>) => {
    const url = info?.previewUrl;
    if (!url || !iframeRef.current?.contentWindow) return;
    try { iframeRef.current.contentWindow.postMessage({ source: 'claudable-comments-cmd', ...msg }, new URL(url).origin); } catch { /* not ready */ }
  }, [info?.previewUrl]);

  const loadComments = useCallback(async (r: string) => {
    if (!info) return;
    try {
      const res = await fetch(`${API_BASE}/api/projects/${info.projectId}/comments?route=${encodeURIComponent(r)}&shareToken=${encodeURIComponent(token)}`);
      const j = await res.json();
      if (j.success) setComments((j.data as any[]).map((c, i) => ({ ...c, index: i + 1 })));
    } catch { /* ignore */ }
  }, [info, token]);

  // Track pane size for popover clamping.
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const compute = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [info?.previewUrl, nameConfirmed]);

  // Bridge: enter comment mode + receive route/pins.
  useEffect(() => {
    if (!info?.previewUrl || !nameConfirmed) return;
    let origin: string;
    try { origin = new URL(info.previewUrl).origin; } catch { return; }
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== origin) return;
      const d = e.data as any;
      if (d?.source === 'claudable-preview' && typeof d.path === 'string') {
        // The plugin posts its route on (re)init — this is our "iframe is ready"
        // handshake. Re-arm comment mode + re-draw pins now that its listener
        // exists; the single enter() on mount races the iframe load and is lost.
        setPreviewLoaded(true); // hides the "starting…" overlay + stops retrying
        post({ type: 'enter' });
        post({ type: 'renderPins', activeId: activeIdRef.current, pins: commentsRef.current.map((c) => ({ id: c.id, index: c.index, anchorSelector: c.anchorSelector, relX: c.relX, relY: c.relY, resolved: c.resolved })) });
        setRoute(d.path.startsWith('/') ? d.path : `/${d.path}`);
      } else if (d?.source === 'claudable-comments') {
        if (d.type === 'placed') { setActiveId(null); setCompose({ anchorSelector: d.anchorSelector, relX: d.relX, relY: d.relY, x: d.x, y: d.y }); }
        else if (d.type === 'pinPositions') { const m: Record<string, { x: number | null; y: number | null }> = {}; (d.positions || []).forEach((p: any) => { m[p.id] = { x: p.x, y: p.y }; }); setPositions(m); }
        else if (d.type === 'pinClicked') { setCompose(null); setActiveId(d.id); }
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [info?.previewUrl, nameConfirmed, post]);

  // Enter comment mode once ready.
  useEffect(() => { if (info?.previewUrl && nameConfirmed) post({ type: 'enter' }); }, [info?.previewUrl, nameConfirmed, post]);
  // The share endpoint returns immediately and warms the dev server in the
  // background, so the first iframe load can hit a not-yet-ready (502) preview.
  // Reload it every few seconds until the plugin reports ready, then stop.
  useEffect(() => {
    if (!nameConfirmed || !info?.previewUrl || previewLoaded) return;
    let tries = 0;
    const id = setInterval(() => {
      tries += 1;
      if (tries > 20) { clearInterval(id); return; } // ~70s ceiling
      setReloadKey((k) => k + 1);
    }, 3500);
    return () => clearInterval(id);
  }, [nameConfirmed, info?.previewUrl, previewLoaded]);
  // Reload pins on route change.
  useEffect(() => { if (nameConfirmed) { setActiveId(null); setCompose(null); loadComments(route); } }, [route, nameConfirmed, loadComments]);
  // Push pins to the bridge.
  useEffect(() => {
    if (!nameConfirmed) return;
    post({ type: 'renderPins', activeId, pins: comments.map((c) => ({ id: c.id, index: c.index, anchorSelector: c.anchorSelector, relX: c.relX, relY: c.relY, resolved: c.resolved })) });
  }, [comments, activeId, nameConfirmed, post]);

  const submitNew = useCallback(async (bodyText: string): Promise<boolean> => {
    if (!compose || !info) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${info.projectId}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ route: routeRef.current || '/', anchorSelector: compose.anchorSelector, relX: compose.relX, relY: compose.relY, body: bodyText, shareToken: token, authorName: guestName }),
      });
      const j = await res.json().catch(() => null);
      if (j?.success) { setCompose(null); await loadComments(routeRef.current || '/'); return true; }
      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }, [compose, info, token, guestName, loadComments]);

  if (error) return <div className="h-screen flex items-center justify-center text-gray-500">{error}</div>;
  if (!info) return (
    <div className="h-screen flex flex-col items-center justify-center gap-3 text-gray-400">
      <svg className="animate-spin text-[#DE7356]" width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-20" /><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /></svg>
      <p className="text-sm">Starting the preview… this can take up to a minute on first open.</p>
    </div>
  );

  if (!nameConfirmed) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-6 w-80">
          <h1 className="text-lg font-semibold text-gray-900 mb-1">Review “{info.projectName}”</h1>
          <p className="text-sm text-gray-500 mb-4">Enter your name so your comments are attributed.</p>
          <input
            autoFocus value={guestName} onChange={(e) => setGuestName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && guestName.trim()) { try { localStorage.setItem('claudable-guest-name', guestName.trim()); } catch {} setNameConfirmed(true); } }}
            placeholder="Your name" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-[#DE7356]/30"
          />
          <button
            onClick={() => { if (guestName.trim()) { try { localStorage.setItem('claudable-guest-name', guestName.trim()); } catch {} setNameConfirmed(true); } }}
            disabled={!guestName.trim()}
            className="w-full h-9 rounded-lg bg-[#DE7356] text-white text-sm font-medium hover:bg-[#c65f43] disabled:opacity-40"
          >Start reviewing</button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100">
      <div className="h-12 shrink-0 bg-white border-b border-gray-200 flex items-center px-4 gap-3">
        <span className="w-2 h-2 rounded-full bg-[#DE7356]" />
        <span className="font-semibold text-gray-900 text-sm">{info.projectName}</span>
        <span className="text-xs text-gray-400">review · click anywhere to comment · {route}</span>
        <span className="ml-auto text-xs text-gray-500">You: {guestName}</span>
      </div>
      <div ref={paneRef} className="relative flex-1 min-h-0">
        {info.previewUrl ? (
          <iframe key={reloadKey} ref={iframeRef} src={info.previewUrl} className="w-full h-full border-none bg-white" />
        ) : (
          <div className="h-full flex items-center justify-center text-gray-400">Preview is starting… refresh in a moment.</div>
        )}
        {info.previewUrl && !previewLoaded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-50/95 text-gray-500 z-40">
            <svg className="animate-spin text-[#DE7356]" width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-20" /><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /></svg>
            <p className="text-sm">Starting the preview… this can take up to a minute on first open.</p>
          </div>
        )}
        <CommentsLayer
          comments={comments}
          positions={positions}
          activeId={activeId}
          compose={compose}
          viewport={viewport}
          onSubmitNew={submitNew}
          onCancelCompose={() => setCompose(null)}
          onResolve={() => { /* guests can't resolve */ }}
          onDelete={() => { /* guests can't delete */ }}
          onCloseThread={() => setActiveId(null)}
        />
      </div>
    </div>
  );
}
