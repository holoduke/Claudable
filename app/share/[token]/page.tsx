"use client";
import { use, useCallback, useEffect, useRef, useState, useSyncExternalStore, useLayoutEffect } from 'react';
import CommentsLayer, { type CommentPin, type ComposeAnchor } from '@/components/chat/CommentsLayer';
import { normalizePreviewRoute } from '@/lib/utils/preview-route';
import { useT } from '@/contexts/I18nContext';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface ShareInfo { projectId: string; projectName: string; previewUrl: string | null }

const GUEST_NAME_KEY = 'claudable-guest-name';
// The saved guest name is read straight from localStorage; nothing needs to be
// notified of changes (the name is only written once, on confirm).
const subscribeNoop = () => () => {};
const readSavedGuestName = (): string | null => {
  try { return localStorage.getItem(GUEST_NAME_KEY) || null; } catch { return null; }
};
const noSavedGuestNameOnServer = (): string | null => null;
// Readiness poll: every 2.5s for up to ~3 minutes (a cold start incl. install).
const READY_POLL_MS = 2500;
const READY_POLL_MAX_TRIES = 72;
// Stacks without the injected preview plugin (Next, Angular, …) never send the
// claudable-preview handshake. If it hasn't arrived this long after the iframe
// loaded, commenting can't work there — say so instead of an armed comment mode
// that silently does nothing.
const BRIDGE_HANDSHAKE_TIMEOUT_MS = 8000;

/** Public stakeholder-review page: live preview + leave pinned comments as a guest. */
export default function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A previously entered guest name (restored from localStorage after hydration)
  // skips the name prompt; otherwise the typed name is used once confirmed.
  const savedGuestName = useSyncExternalStore(subscribeNoop, readSavedGuestName, noSavedGuestNameOnServer);
  const [typedName, setTypedName] = useState<string>('');
  const [typedConfirmed, setTypedConfirmed] = useState(false);
  const nameConfirmed = typedConfirmed || savedGuestName !== null;
  const guestName = typedConfirmed ? typedName : (savedGuestName ?? typedName);
  const [route, setRoute] = useState('/');
  const [comments, setComments] = useState<CommentPin[]>([]);
  const [positions, setPositions] = useState<Record<string, { x: number | null; y: number | null }>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeAnchor | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Server-side confirmation that the dev server answers (GET /api/share/:token/ready).
  // Until then the iframe isn't mounted at all: it would only show the proxy's
  // "Bad Gateway" page, and its onLoad must not count as "loaded".
  const [serverReady, setServerReady] = useState(false);
  const [readyTimedOut, setReadyTimedOut] = useState(false);
  // Comment mode ON = clicks place comments (links intercepted); OFF = browse
  // the site normally (links/buttons work). Existing comment pins stay visible
  // and clickable in both modes.
  const [commentMode, setCommentMode] = useState(true);
  // null = unknown yet; true = handshake seen; false = no bridge (timed out).
  const [bridgeAvailable, setBridgeAvailable] = useState<boolean | null>(null);
  const bridgeSeenRef = useRef(false);
  const bridgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (bridgeTimerRef.current) clearTimeout(bridgeTimerRef.current); }, []);
  const commentingOff = bridgeAvailable === false;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const routeRef = useRef('/');
  routeRef.current = route;
  const commentModeRef = useRef(true);
  commentModeRef.current = commentMode;
  const commentsRef = useRef<CommentPin[]>([]);
  commentsRef.current = comments;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  // Resolve the share link.
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/api/share/${token}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((j) => {
        if (controller.signal.aborted) return;
        if (j.success) setInfo(j.data); else setError(t('home.share.invalid'));
      })
      .catch(() => { if (!controller.signal.aborted) setError(t('home.share.loadFailed')); });
    return () => { controller.abort(); };
  }, [token, t]);

  const post = useCallback((msg: Record<string, unknown>) => {
    const url = info?.previewUrl;
    if (!url || !iframeRef.current?.contentWindow) return;
    try { iframeRef.current.contentWindow.postMessage({ source: 'claudable-comments-cmd', ...msg }, new URL(url).origin); } catch { /* not ready */ }
  }, [info?.previewUrl]);

  const loadComments = useCallback(async (r: string) => {
    if (!info) return;
    try {
      const res = await fetch(`${API_BASE}/api/projects/${info.projectId}/comments?route=${encodeURIComponent(r)}`, { headers: { 'X-Share-Token': token } });
      const j = await res.json();
      if (j.success) setComments((j.data as any[]).map((c, i) => ({ ...c, index: i + 1 })));
    } catch { /* ignore */ }
  }, [info, token]);

  // Track pane size for popover clamping.
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- measuring the DOM before paint is what a layout effect is for
    const compute = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    // Measure before paint (layout effect): ResizeObserver's first callback only
    // arrives a frame later.
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
        bridgeSeenRef.current = true;
        setBridgeAvailable(true);
        post({ type: commentModeRef.current ? 'enter' : 'exit' }); // respect the toggle
        post({ type: 'renderPins', activeId: activeIdRef.current, pins: commentsRef.current.map((c) => ({ id: c.id, index: c.index, anchorSelector: c.anchorSelector, relX: c.relX, relY: c.relY, resolved: c.resolved })) });
        setRoute(normalizePreviewRoute(d.path)); // pathname only (older plugins send the query)
      } else if (d?.source === 'claudable-comments') {
        if (d.type === 'placed') { setActiveId(null); setCompose({ anchorSelector: d.anchorSelector, relX: d.relX, relY: d.relY, x: d.x, y: d.y }); }
        else if (d.type === 'pinPositions') { const m: Record<string, { x: number | null; y: number | null }> = {}; (d.positions || []).forEach((p: any) => { m[p.id] = { x: p.x, y: p.y }; }); setPositions(m); }
        else if (d.type === 'pinClicked') { setCompose(null); setActiveId(d.id); }
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [info?.previewUrl, nameConfirmed, post]);

  // Send enter/exit when the toggle flips (and once ready). Turning it off lets
  // the reviewer click links/buttons; existing pins stay visible either way.
  useEffect(() => {
    if (!info?.previewUrl || !nameConfirmed) return;
    post({ type: commentMode ? 'enter' : 'exit' });
  }, [commentMode, info?.previewUrl, nameConfirmed, previewLoaded, post]);
  // The share endpoint returns immediately and warms the dev server in the
  // background. Poll the token-gated readiness probe until the dev server
  // actually answers; only then mount the iframe.
  useEffect(() => {
    if (!info?.previewUrl || serverReady) return;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      tries += 1;
      try {
        const res = await fetch(`${API_BASE}/api/share/${token}/ready`, { cache: 'no-store' });
        const j = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.status === 404) { setError(t('home.share.invalid')); return; }
        if (j?.success && j.data?.ready === true) { setServerReady(true); return; }
      } catch { /* network blip — keep polling */ }
      if (cancelled) return;
      if (tries >= READY_POLL_MAX_TRIES) { setReadyTimedOut(true); return; }
      timer = setTimeout(() => { void poll(); }, READY_POLL_MS);
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [info?.previewUrl, serverReady, token, t]);
  // Once the server is up, reload the iframe every few seconds until the plugin
  // reports ready (or the onLoad fallback fires), then stop.
  useEffect(() => {
    if (!nameConfirmed || !info?.previewUrl || !serverReady || previewLoaded) return;
    let tries = 0;
    const id = setInterval(() => {
      tries += 1;
      if (tries > 20) { clearInterval(id); return; } // ~70s ceiling
      setReloadKey((k) => k + 1);
    }, 3500);
    return () => clearInterval(id);
  }, [nameConfirmed, info?.previewUrl, serverReady, previewLoaded]);
  // Reload pins on route change; drop the open thread/composer first
  // (adjusted during render rather than in the effect).
  const [pinsResetFor, setPinsResetFor] = useState<{ route: string; nameConfirmed: boolean } | null>(null);
  if (!pinsResetFor || pinsResetFor.route !== route || pinsResetFor.nameConfirmed !== nameConfirmed) {
    setPinsResetFor({ route, nameConfirmed });
    if (nameConfirmed) { setActiveId(null); setCompose(null); }
  }
  useEffect(() => { if (nameConfirmed) loadComments(route); }, [route, nameConfirmed, loadComments]);
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

  if (error) return <div className="h-screen flex items-center justify-center text-gray-500 dark:text-gray-400">{error}</div>;
  if (!info) return (
    <div className="h-screen flex flex-col items-center justify-center gap-3 text-gray-400 dark:text-gray-500">
      <svg className="animate-spin text-brand-500" width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-20" /><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /></svg>
      <p className="text-sm">{t('home.share.starting')}</p>
    </div>
  );

  if (!nameConfirmed) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-6 w-80">
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-50 mb-1">{t('home.share.reviewTitle', { name: info.projectName })}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t('home.share.namePrompt')}</p>
          <input
            autoFocus value={guestName} onChange={(e) => setTypedName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && guestName.trim()) { try { localStorage.setItem(GUEST_NAME_KEY, guestName.trim()); } catch {} setTypedConfirmed(true); } }}
            placeholder={t('home.share.namePlaceholder')} aria-label={t('home.share.namePlaceholder')} className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-hidden focus:ring-2 focus:ring-brand-500/30"
          />
          <button
            onClick={() => { if (guestName.trim()) { try { localStorage.setItem(GUEST_NAME_KEY, guestName.trim()); } catch {} setTypedConfirmed(true); } }}
            disabled={!guestName.trim()}
            className="w-full h-9 rounded-lg bg-brand-500 text-white text-sm font-medium hover:bg-brand-600 disabled:opacity-40"
          >{t('home.share.start')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100 dark:bg-gray-800">
      <div className="h-12 shrink-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 flex items-center px-4 gap-3">
        <span className="w-2 h-2 rounded-full bg-brand-500" />
        <span className="font-semibold text-gray-900 dark:text-gray-50 text-sm">{info.projectName}</span>
        {commentingOff ? (
          <span role="status" title={t('home.share.commentsUnavailableHint')} className="text-xs text-gray-500 dark:text-gray-400">
            {t('home.share.commentsUnavailable')} · {route}
          </span>
        ) : (<>
        <button
          type="button"
          aria-pressed={commentMode}
          onClick={() => {
            const next = !commentMode;
            setCommentMode(next);
            // Browsing mode closes any open composer/thread.
            if (!next) { setCompose(null); setActiveId(null); }
          }}
          title={commentMode ? t('home.share.commentOnTitle') : t('home.share.browseTitle')}
          className={`h-8 flex items-center gap-1.5 px-2.5 rounded-lg text-xs font-medium border transition-colors ${
            commentMode ? 'bg-brand-500 text-white border-brand-500' : 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
          }`}
        >
          <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></svg>
          {commentMode ? t('home.share.commenting') : t('home.share.comment')}
        </button>
        <span className="text-xs text-gray-400 dark:text-gray-500 hidden sm:inline">{commentMode ? t('home.share.hintComment') : t('home.share.hintBrowse')} · {route}</span>
        </>)}
        <span className="ml-auto text-xs text-gray-500 dark:text-gray-400 truncate">{t('home.share.you', { name: guestName })}</span>
      </div>
      <div ref={paneRef} className="relative flex-1 min-h-0">
        {info.previewUrl && serverReady ? (
          <iframe
            key={reloadKey}
            ref={iframeRef}
            src={info.previewUrl}
            className="w-full h-full border-none bg-white dark:bg-gray-900"
            onLoad={() => {
              // Fallback: on stacks without the injected plugin (Next/Angular) the
              // claudable-preview handshake never arrives. Dismiss the overlay a
              // moment after the iframe loads so it can't cover a working app
              // forever (comment mode just won't arm on those stacks). Safe: the
              // iframe only mounts once the readiness probe saw the server up,
              // so this load is the app, not the proxy's 502 page.
              setTimeout(() => setPreviewLoaded(true), 1500);
              // No handshake within the timeout → this stack has no comment
              // bridge: turn comment mode off and say commenting is unavailable.
              if (!bridgeSeenRef.current) {
                if (bridgeTimerRef.current) clearTimeout(bridgeTimerRef.current);
                bridgeTimerRef.current = setTimeout(() => {
                  if (bridgeSeenRef.current) return;
                  setBridgeAvailable(false);
                  setCommentMode(false);
                  setCompose(null);
                  setActiveId(null);
                }, BRIDGE_HANDSHAKE_TIMEOUT_MS);
              }
            }}
          />
        ) : !info.previewUrl ? (
          <div className="h-full flex items-center justify-center text-gray-400 dark:text-gray-500">{t('home.share.startingRefresh')}</div>
        ) : null}
        {info.previewUrl && !previewLoaded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-50 dark:bg-gray-900/95 text-gray-500 dark:text-gray-400 z-40 pointer-events-none">
            {readyTimedOut ? (
              <p className="text-sm">{t('home.share.didNotStart')}</p>
            ) : (
              <>
                <svg className="animate-spin text-brand-500" width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-20" /><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /></svg>
                <p className="text-sm">{t('home.share.starting')}</p>
              </>
            )}
          </div>
        )}
        <CommentsLayer
          comments={comments}
          positions={positions}
          activeId={activeId}
          compose={compose}
          viewport={viewport}
          onSubmitNew={submitNew}
          readOnly
          onCancelCompose={() => setCompose(null)}
          onResolve={() => { /* guests can't resolve */ }}
          onDelete={() => { /* guests can't delete */ }}
          onCloseThread={() => setActiveId(null)}
        />
      </div>
    </div>
  );
}
