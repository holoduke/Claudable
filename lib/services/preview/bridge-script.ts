// The Claudable preview bridge as plain browser JS: route sync for the URL bar,
// visual editor (click-to-select + live edits), pinned comments and runtime
// error capture ("Fix with AI"). One source, two delivery paths:
//  - Nuxt: wrapped in a client plugin written into the project (route-reporter.ts),
//    routes via useRouter();
//  - every other stack: served as /__claudable/bridge.js by the preview bridge
//    proxy (bridge-proxy.ts) or inlined by the PHP prepend (bridge-php.ts),
//    routes via the History API.
// Everything is inert outside the preview iframe (window.parent === window).
// The empty catch blocks are deliberate: this runs inside arbitrary user apps,
// so every hook is best-effort and must never break or spam the host page.
import { clientLogToken } from '@/lib/services/client-log-token';

export type BridgeRouteMode = 'nuxt-router' | 'history';

export interface BridgeOptions {
  /** Exact Claudable origin; '' falls back to the referrer/ancestor origin, else the bridge stays silent. */
  claudableOrigin: string;
  projectId: string;
  /** Per-project client-log token (see client-log-token.ts). */
  logToken: string;
  route: BridgeRouteMode;
}

/** The exact Claudable origin (NEXT_PUBLIC_APP_URL, else AUTH_URL), or '' when unknown. */
export function claudableOriginFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  try { return new URL(env.NEXT_PUBLIC_APP_URL || env.AUTH_URL || '').origin; } catch { return ''; }
}

export function bridgeOptionsFor(projectId: string, route: BridgeRouteMode): BridgeOptions {
  return { claudableOrigin: claudableOriginFromEnv(), projectId, logToken: clientLogToken(projectId), route };
}

const FIRST_LINE = `  if (typeof window === 'undefined' || window.parent === window) return;
`;

// Non-Nuxt pages may receive the bridge twice (e.g. an app that also ships the
// Nuxt plugin behind the proxy) — the second copy must not double every listener.
const HISTORY_GUARD = `  if (window.__claudablePreviewBridge) return;
  window.__claudablePreviewBridge = true;
`;

const NUXT_ROUTE = `  try {
    const router = useRouter();
    postRoute(router.currentRoute.value.path);
    router.afterEach((to) => postRoute(to.path));
  } catch {}
`;

// History-API route reporter for any framework (React Router, Vue Router, Next,
// Angular, SvelteKit, plain multi-page sites): report the initial path, every
// pushState/replaceState and every popstate/hashchange. Pathname only (the same
// split as postRoute), deduplicated so a query-only replaceState stays quiet.
const HISTORY_ROUTE = `  let lastRoute = null;
  const reportRoute = () => {
    const p = String(window.location.pathname || '/');
    if (p === lastRoute) return;
    lastRoute = p;
    postRoute(p);
  };
  try {
    ['pushState', 'replaceState'].forEach((m) => {
      const orig = window.history[m];
      if (typeof orig !== 'function') return;
      window.history[m] = function () {
        const r = orig.apply(this, arguments);
        try { reportRoute(); } catch {}
        return r;
      };
    });
  } catch {}
  window.addEventListener('popstate', reportRoute);
  window.addEventListener('hashchange', reportRoute);
  reportRoute();
`;

const REST = `
  // --- visual editor bridge: click-to-select + live CSS/text editing ----------
  let editing = false;
  let selected = null;
  let hoverBox = null;
  let selBox = null;
  const ensureBoxes = () => {
    if (hoverBox) return;
    const mk = (color, bg) => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid ' + color +
        ';border-radius:2px;background:' + bg + ';display:none;box-sizing:border-box;transition:all .04s ease-out;';
      document.body.appendChild(d);
      return d;
    };
    hoverBox = mk('#3b82f6', 'rgba(59,130,246,0.06)');
    selBox = mk('#DE7356', 'rgba(222,115,86,0.08)');
  };
  const drawBox = (el, box) => {
    if (!el || !box) return;
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
  };
  // Stable-ish CSS selector path (id short-circuits; else nth-of-type chain).
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
      if (node.id) { parts.unshift('#' + (window.CSS && CSS.escape ? CSS.escape(node.id) : node.id)); break; }
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const CURATED = ['color','backgroundColor','fontSize','fontWeight','lineHeight','letterSpacing','textAlign','padding','margin','borderRadius','borderWidth','borderColor','width','height','display','opacity'];
  const describe = (el) => {
    const cs = getComputedStyle(el);
    const styles = {};
    CURATED.forEach((k) => { styles[k] = cs[k]; });
    return {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.prototype.slice.call(el.classList),
      text: (el.textContent || '').trim().slice(0, 300),
      editableText: el.children.length === 0,
      styles,
    };
  };
  const onOver = (e) => { if (!editing) return; const t = e.target; if (!t || t === document.body) return; ensureBoxes(); drawBox(t, hoverBox); };
  const onOut = () => { if (hoverBox) hoverBox.style.display = 'none'; };
  const onClick = (e) => {
    if (!editing) return;
    e.preventDefault(); e.stopPropagation();
    selected = e.target;
    ensureBoxes(); drawBox(selected, selBox); hoverBox.style.display = 'none';
    post({ source: 'claudable-editor', type: 'selected', element: describe(selected) });
  };
  const enter = () => {
    if (editing) return;
    editing = true; ensureBoxes();
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('click', onClick, true);
    document.documentElement.style.cursor = 'crosshair';
  };
  const exit = () => {
    editing = false;
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('mouseout', onOut, true);
    document.removeEventListener('click', onClick, true);
    if (hoverBox) hoverBox.style.display = 'none';
    if (selBox) selBox.style.display = 'none';
    document.documentElement.style.cursor = '';
    selected = null;
  };
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!trusted(ev) || !d || d.source !== 'claudable-editor-cmd') return;
    if (d.type === 'enter') enter();
    else if (d.type === 'exit') exit();
    else if (d.type === 'applyStyle' && selected) { try { selected.style[d.prop] = d.value; drawBox(selected, selBox); } catch {} }
    else if (d.type === 'applyText' && selected) { try { selected.textContent = d.value; drawBox(selected, selBox); } catch {} }
  });
  window.addEventListener('scroll', () => { if (selected) drawBox(selected, selBox); }, true);
  window.addEventListener('resize', () => { if (selected) drawBox(selected, selBox); });

  // --- comments bridge: pinned review annotations (Claudable-only overlay) -----
  let commenting = false;
  let pins = [];
  const pinEls = new Map();
  let rafPos = 0;
  const pinLayer = () => {
    let l = document.getElementById('__claudable_pins');
    if (!l) {
      l = document.createElement('div');
      l.id = '__claudable_pins';
      l.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
      document.body.appendChild(l);
    }
    return l;
  };
  const anchorPos = (p) => {
    let el; try { el = document.querySelector(p.anchorSelector); } catch { el = null; }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + p.relX * r.width, y: r.top + p.relY * r.height };
  };
  const positionPins = () => {
    if (!pins.length) return; // nothing to report — don't spam the parent on scroll
    const out = [];
    pins.forEach((p) => {
      const dot = pinEls.get(p.id);
      const pos = anchorPos(p);
      if (dot) {
        if (pos) { dot.style.display = 'block'; dot.style.left = pos.x + 'px'; dot.style.top = pos.y + 'px'; }
        else { dot.style.display = 'none'; }
      }
      out.push({ id: p.id, x: pos ? pos.x : null, y: pos ? pos.y : null });
    });
    post({ source: 'claudable-comments', type: 'pinPositions', positions: out });
  };
  const schedulePos = () => { if (rafPos) return; rafPos = requestAnimationFrame(() => { rafPos = 0; positionPins(); }); };
  const renderPins = (list, activeId) => {
    pins = list || [];
    const layer = pinLayer();
    for (const [id, el] of pinEls) { if (!pins.find((p) => p.id === id)) { el.remove(); pinEls.delete(id); } }
    pins.forEach((p) => {
      let dot = pinEls.get(p.id);
      if (!dot) {
        dot = document.createElement('div');
        dot.style.cssText = 'position:fixed;width:24px;height:24px;margin:-24px 0 0 0;border-radius:50% 50% 50% 2px;background:#DE7356;color:#fff;font:600 12px/22px system-ui;text-align:center;cursor:pointer;pointer-events:auto;box-shadow:0 2px 6px rgba(0,0,0,.35);border:2px solid #fff;';
        dot.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); post({ source: 'claudable-comments', type: 'pinClicked', id: p.id }); });
        layer.appendChild(dot);
        pinEls.set(p.id, dot);
      }
      dot.textContent = String(p.index);
      dot.style.opacity = p.resolved ? '0.4' : '1';
      dot.style.outline = p.id === activeId ? '3px solid rgba(222,115,86,.4)' : 'none';
    });
    positionPins();
  };
  const onCommentClick = (e) => {
    if (!commenting) return;
    const t = e.target;
    if (t && t.closest && t.closest('#__claudable_pins')) return;
    e.preventDefault(); e.stopPropagation();
    const r = t.getBoundingClientRect();
    const relX = r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0.5;
    const relY = r.height ? Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) : 0.5;
    post({ source: 'claudable-comments', type: 'placed', anchorSelector: cssPath(t), relX, relY, x: e.clientX, y: e.clientY });
  };
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!trusted(ev) || !d || d.source !== 'claudable-comments-cmd') return;
    if (d.type === 'enter') {
      if (!commenting) { commenting = true; document.addEventListener('click', onCommentClick, true); document.documentElement.style.cursor = 'crosshair'; }
    } else if (d.type === 'exit') {
      commenting = false; document.removeEventListener('click', onCommentClick, true); document.documentElement.style.cursor = '';
    } else if (d.type === 'renderPins') {
      renderPins(d.pins, d.activeId);
    } else if (d.type === 'scrollTo') {
      // Jump to a comment's anchor element and briefly flash it, then reposition pins.
      try {
        const el = document.querySelector(d.anchorSelector);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          const prevOutline = el.style.outline;
          const prevTransition = el.style.transition;
          el.style.transition = 'outline .2s ease';
          el.style.outline = '3px solid rgba(222,115,86,.8)';
          setTimeout(() => { try { el.style.outline = prevOutline; el.style.transition = prevTransition; } catch {} }, 1400);
        }
      } catch {}
      setTimeout(schedulePos, 400);
    }
  });
  window.addEventListener('scroll', schedulePos, true);
  window.addEventListener('resize', schedulePos);

  // --- error bridge: report runtime errors so Claudable can offer a one-click fix ---
  const seenErrors = new Set();
  const reportError = (kind, msg, extra) => {
    if (!msg) return;
    const line = (kind + '|' + msg + '|' + (extra || '')).slice(0, 600);
    if (seenErrors.has(line)) return; // dedupe repeats
    if (seenErrors.size > 500) seenErrors.clear(); // bound memory on high-variance errors
    seenErrors.add(line);
    post({ source: 'claudable-errors', type: 'error', error: { kind, message: String(msg).slice(0, 500), at: (extra || '').slice(0, 200) } });
    ship('error', kind + ': ' + msg, extra);
  };

  // Ship console/runtime errors to Claudable (server-side buffer) so the agent
  // can query "what's broken?" even when no chat window is watching. Batched,
  // text/plain (a CORS "simple" request → no preflight), fire-and-forget.
  const SHIP_URL = CLAUDABLE_ORIGIN && CLAUDABLE_PROJECT_ID ? CLAUDABLE_ORIGIN + '/api/projects/' + encodeURIComponent(CLAUDABLE_PROJECT_ID) + '/client-logs?t=' + encodeURIComponent(CLAUDABLE_LOG_TOKEN) : '';
  let shipQueue = [];
  let shipTimer = 0;
  const ship = (level, message, at) => {
    if (!SHIP_URL || !message) return;
    shipQueue.push({ level: level, message: String(message).slice(0, 600), at: String(at || '').slice(0, 200) });
    if (shipQueue.length > 40) shipQueue.shift();
    if (shipTimer) return;
    shipTimer = setTimeout(() => {
      shipTimer = 0;
      const batch = shipQueue.splice(0, shipQueue.length);
      if (!batch.length) return;
      try { fetch(SHIP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ entries: batch }), keepalive: true }).catch(function () {}); } catch (_e) {}
    }, 1500);
  };
  window.addEventListener('error', (e) => {
    if (e && e.message) reportError('runtime', e.message, (e.filename || '') + (e.lineno ? ':' + e.lineno : ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    reportError('promise', (r && (r.message || r.toString())) || 'Unhandled promise rejection', '');
  });
  try {
    const origErr = console.error.bind(console);
    console.error = function () {
      try {
        const parts = Array.prototype.map.call(arguments, (a) => (a && a.stack) ? a.stack : (typeof a === 'object' ? '' : String(a))).filter(Boolean);
        const msg = parts.join(' ').trim();
        // Skip framework HMR/noise; only surface things that look like real errors.
        if (msg && /error|failed|cannot|undefined is not|is not a function|unexpected|exception/iu.test(msg)) reportError('console', msg, '');
      } catch {}
      return origErr.apply(console, arguments);
    };
    // console.warn → shipped to the diagnostics buffer only (no "Fix with AI"
    // banner; warnings are context for the agent, not user-facing alerts).
    const origWarn = console.warn.bind(console);
    console.warn = function () {
      try {
        const msg = Array.prototype.map.call(arguments, (a) => (a && a.stack) ? a.stack : String(a)).join(' ').trim();
        // Only ship substantive warnings (deprecations, leaks, hydration, a11y…)
        // and dedupe — a framework warning on every render must not spam the buffer.
        const key = 'warn|' + msg.slice(0, 200);
        if (msg && /deprecat|will be removed|memory leak|hydrat|mismatch|invalid|missing|failed|slow|violation|accessib/iu.test(msg) && !seenErrors.has(key)) {
          if (seenErrors.size > 500) seenErrors.clear();
          seenErrors.add(key);
          ship('warn', msg, '');
        }
      } catch {}
      return origWarn.apply(console, arguments);
    };
  } catch {}
`;

function preamble(o: BridgeOptions): string {
  return `  // Known Claudable origin (baked in). Without one (local dev without
  // NEXT_PUBLIC_APP_URL/AUTH_URL) fall back to the referrer/ancestor origin; if
  // that is unknown too the bridge stays silent — never '*'. The target scopes
  // BOTH outgoing posts and incoming commands, so a page that frames the
  // preview can't drive it.
  const CLAUDABLE_ORIGIN = ${JSON.stringify(o.claudableOrigin)};
  const CLAUDABLE_PROJECT_ID = ${JSON.stringify(o.projectId)};
  const CLAUDABLE_LOG_TOKEN = ${JSON.stringify(o.logToken)};
  let target = CLAUDABLE_ORIGIN;
  try {
    if (!target && document.referrer) target = new URL(document.referrer).origin;
    if (!target && window.location.ancestorOrigins && window.location.ancestorOrigins.length) target = window.location.ancestorOrigins[0];
  } catch {}
  if (target === 'null') target = '';
  const trusted = (ev) => !!target && ev.origin === target;
  const post = (msg) => { if (!target) return; try { window.parent.postMessage(msg, target); } catch {} };

  // --- route reporter: keep the preview URL bar in sync with in-app navigation ---
  // Pathname ONLY: Claudable scopes review comments by route, and a query or
  // hash (e.g. its own ?_ts= cache-buster on refresh) must not split them.
  const postRoute = (p) => post({ source: 'claudable-preview', path: String(p || '/').split(/[?#]/)[0] || '/' });
`;
}

/**
 * The bridge as function-body statements (uses `return` to bail out). The
 * Nuxt plugin wraps it in defineNuxtPlugin; bridgeCoreSource wraps it in an IIFE.
 */
export function bridgeCoreBody(o: BridgeOptions): string {
  return o.route === 'history'
    ? FIRST_LINE + HISTORY_GUARD + preamble(o) + HISTORY_ROUTE + REST
    : FIRST_LINE + preamble(o) + NUXT_ROUTE + REST;
}

/** The bridge as a standalone browser script (an IIFE). */
export function bridgeCoreSource(o: BridgeOptions): string {
  return `// Claudable preview bridge (preview only; inert outside the preview iframe).
(function () {
${bridgeCoreBody(o)}})();
`;
}

/** The Nuxt client plugin (written into the project, gitignored). */
export function nuxtPluginSource(o: BridgeOptions): string {
  return `// Auto-added by Claudable (preview only). Reports the current route to the
// Claudable parent window so the preview URL bar can follow in-app navigation.
// Inert outside the preview iframe; gitignored so it never ships to production.
export default defineNuxtPlugin(() => {
${bridgeCoreBody(o)}});
`;
}
