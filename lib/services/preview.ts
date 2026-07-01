/**
 * PreviewManager - Handles per-project development servers (live preview)
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { findAvailablePort } from '@/lib/utils/ports';
import { getProjectById, updateProject, updateProjectStatus } from './project';
import { prisma } from '@/lib/db/client';
import { getDatabaseUrl } from '@/lib/services/database';
import { recordBackendChunk } from '@/lib/services/diagnostics';

/**
 * Clear persisted preview URLs/ports for ALL projects. Called once on boot: after
 * a restart the in-memory process map is empty and every dev server is dead, so a
 * cached previewUrl/previewPort is stale and — since ports get reused across
 * projects — could otherwise point a project at another project's preview.
 */
async function clearAllPreviewState(): Promise<void> {
  try {
    await prisma.project.updateMany({
      where: { OR: [{ previewUrl: { not: null } }, { previewPort: { not: null } }] },
      data: { previewUrl: null, previewPort: null },
    });
  } catch {
    /* non-fatal: the frontend uses live status, this is defense-in-depth */
  }
}

// --- Per-project preview routing --------------------------------------------
// A stable per-project subdomain (preview-<slug>.<domain>) whose Traefik route we
// rewrite to the current port on every start. Because the hostname is keyed to the
// PROJECT (not the port), a port getting reused by another project can never make
// one project's preview show another's — the definitive fix for the port-reuse leak.
const PREVIEW_ROUTE_PREFIX = 'preview-';
// Marker on the first line of every route file we manage, so the boot sweep never
// deletes a non-Claudable file that happens to be named preview-*.yml.
const PREVIEW_ROUTE_MARKER = '# claudable-managed-preview';

function previewRouteDir(): string | null {
  const d = process.env.TRAEFIK_DYNAMIC_DIR?.trim();
  return d && d.length ? d : null;
}

/** Active when the URL template is {project}-based AND we have a dynamic route dir. */
function perProjectPreview(): boolean {
  return (process.env.PREVIEW_URL_TEMPLATE || '').includes('{project}') && !!previewRouteDir();
}

function hashSlug(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** projectId → a valid DNS label ('preview-' + slug must stay <= 63 chars).
 * If sanitizing changed the id (two ids could collide) or it's too long, append a
 * hash of the raw id so distinct projects never share a route file. */
function previewSlug(projectId: string): string {
  const s = projectId.toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '');
  const needsHash = s !== projectId.toLowerCase() || s.length > 55;
  return needsHash ? `${s.slice(0, 46).replace(/-$/u, '')}-${hashSlug(projectId)}` : s;
}

function previewUrlFor(projectId: string, port: number): string {
  const tmpl = process.env.PREVIEW_URL_TEMPLATE || '';
  if (tmpl.includes('{project}') && previewRouteDir()) return tmpl.replace('{project}', previewSlug(projectId));
  if (tmpl.includes('{port}')) return tmpl.replace('{port}', String(port));
  return `http://localhost:${port}`;
}

function previewRouteFile(projectId: string): string {
  return path.join(previewRouteDir()!, `${PREVIEW_ROUTE_PREFIX}${previewSlug(projectId)}.yml`);
}

/** Write/refresh this project's Traefik route to point at its current port. */
async function writePreviewRoute(projectId: string, port: number): Promise<void> {
  const dir = previewRouteDir();
  if (!dir) return;
  let host: string;
  try { host = new URL(previewUrlFor(projectId, port)).host; } catch { return; }
  const gw = process.env.DEPLOY_HOST_GATEWAY || 'host.docker.internal';
  const name = `${PREVIEW_ROUTE_PREFIX}${previewSlug(projectId)}`;
  const yaml = `${PREVIEW_ROUTE_MARKER}
# Per-project route so a reused port can't cross projects.
http:
  routers:
    ${name}:
      rule: "Host(\`${host}\`)"
      entryPoints: [https]
      service: ${name}
      tls:
        certResolver: letsencrypt
  services:
    ${name}:
      loadBalancer:
        servers:
          - url: "http://${gw}:${port}"
`;
  await fs.writeFile(previewRouteFile(projectId), yaml, 'utf8').catch(() => {});
}

async function removePreviewRoute(projectId: string): Promise<void> {
  if (!previewRouteDir()) return;
  await fs.unlink(previewRouteFile(projectId)).catch(() => {});
}

/** On boot, remove stale per-project preview routes (their dev servers are dead).
 * Only deletes files that carry OUR marker — never a legit app route that happens
 * to be named preview-*.yml in the shared proxy dir. */
async function sweepPreviewRoutes(): Promise<void> {
  const dir = previewRouteDir();
  if (!dir) return;
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    files
      .filter((f) => f.startsWith(PREVIEW_ROUTE_PREFIX) && f.endsWith('.yml'))
      .map(async (f) => {
        const p = path.join(dir, f);
        const content = await fs.readFile(p, 'utf8').catch(() => '');
        if (content.startsWith(PREVIEW_ROUTE_MARKER)) await fs.unlink(p).catch(() => {});
      }),
  );
}
import { scaffoldForStack } from '@/lib/utils/scaffold-dispatch';
import { stackKind } from '@/lib/config/stacks';
import { PREVIEW_CONFIG } from '@/lib/config/constants';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/**
 * Inject a tiny Nuxt client plugin that reports the current route to the
 * Claudable parent window via postMessage, so the preview URL bar follows
 * in-app (client-side) navigation. The preview is a cross-origin iframe, so the
 * parent can't read its location directly — this is the only reliable way.
 * The plugin is inert outside the preview iframe and is gitignored so it never
 * ships to the deployed app.
 */
async function ensurePreviewRouteReporter(projectPath: string, projectId: string): Promise<void> {
  try {
    // Only meaningful for Nuxt projects.
    const hasNuxtConfig = await fs
      .access(path.join(projectPath, 'nuxt.config.ts'))
      .then(() => true)
      .catch(() => false);
    if (!hasNuxtConfig) return;

    // The exact Claudable origin, baked in so the plugin only ever posts to (and
    // accepts commands from) the real parent — not whatever page frames it.
    let claudableOrigin = '';
    try { claudableOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL || '').origin; } catch { claudableOrigin = ''; }

    const rel = 'plugins/claudable-preview.client.ts';
    const pluginPath = path.join(projectPath, rel);
    await fs.mkdir(path.dirname(pluginPath), { recursive: true });
    await fs.writeFile(
      pluginPath,
      `// Auto-added by Claudable (preview only). Reports the current route to the
// Claudable parent window so the preview URL bar can follow in-app navigation.
// Inert outside the preview iframe; gitignored so it never ships to production.
export default defineNuxtPlugin(() => {
  if (typeof window === 'undefined' || window.parent === window) return;
  // Known Claudable origin (baked in). Fall back to the referrer/ancestor origin,
  // then '*' only as a last resort. Used to scope BOTH outgoing posts and to
  // validate incoming commands, so a page that frames the preview can't drive it.
  const CLAUDABLE_ORIGIN = ${JSON.stringify(claudableOrigin)};
  const CLAUDABLE_PROJECT_ID = ${JSON.stringify(projectId)};
  let target = CLAUDABLE_ORIGIN || '*';
  try {
    if (!CLAUDABLE_ORIGIN && document.referrer) target = new URL(document.referrer).origin;
    if (!CLAUDABLE_ORIGIN && target === '*' && window.location.ancestorOrigins && window.location.ancestorOrigins.length) target = window.location.ancestorOrigins[0];
  } catch {}
  const trusted = (ev) => target === '*' || ev.origin === target;
  const post = (msg) => { try { window.parent.postMessage(msg, target); } catch {} };

  // --- route reporter: keep the preview URL bar in sync with in-app navigation ---
  const postRoute = (p) => post({ source: 'claudable-preview', path: p });
  try {
    const router = useRouter();
    postRoute(router.currentRoute.value.fullPath);
    router.afterEach((to) => postRoute(to.fullPath));
  } catch {}

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
  const SHIP_URL = CLAUDABLE_ORIGIN && CLAUDABLE_PROJECT_ID ? CLAUDABLE_ORIGIN + '/api/projects/' + encodeURIComponent(CLAUDABLE_PROJECT_ID) + '/client-logs' : '';
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
});
`,
      'utf8',
    );

    // Keep it out of git / the deployed image.
    const giPath = path.join(projectPath, '.gitignore');
    let gi = '';
    try { gi = await fs.readFile(giPath, 'utf8'); } catch { /* none yet */ }
    if (!gi.includes(rel)) {
      const sep = gi.length === 0 || gi.endsWith('\n') ? '' : '\n';
      await fs.writeFile(giPath, `${gi}${sep}${rel}\n`, 'utf8');
    }
  } catch {
    // Non-fatal: the route bar just won't follow in-app navigation.
  }
}

/**
 * Kill the dev server AND its children. The dev server is a tree
 * (run-dev.js -> npm -> sh -> nuxt); killing only the parent left the nuxt
 * child alive holding the port, leaking a server on every restart. The child
 * is spawned detached, so a negative PID signals the whole process group.
 */
function killProcessTree(child: ChildProcess | null | undefined): void {
  const pid = child?.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      child!.kill('SIGTERM');
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
      // Hard-stop the group shortly after if anything lingers.
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 4000).unref?.();
    } catch {
      child!.kill('SIGTERM');
    }
  } catch {
    /* already exited */
  }
}
const yarnCommand = process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
const bunCommand = process.platform === 'win32' ? 'bun.exe' : 'bun';

type PackageManagerId = 'npm' | 'pnpm' | 'yarn' | 'bun';

const PACKAGE_MANAGER_COMMANDS: Record<
  PackageManagerId,
  { command: string; installArgs: string[] }
> = {
  npm: { command: npmCommand, installArgs: ['install'] },
  pnpm: { command: pnpmCommand, installArgs: ['install'] },
  yarn: { command: yarnCommand, installArgs: ['install'] },
  bun: { command: bunCommand, installArgs: ['install'] },
};

const LOG_LIMIT = PREVIEW_CONFIG.LOG_LIMIT;
const PREVIEW_FALLBACK_PORT_START = PREVIEW_CONFIG.FALLBACK_PORT_START;
const PREVIEW_FALLBACK_PORT_END = PREVIEW_CONFIG.FALLBACK_PORT_END;
const PREVIEW_MAX_PORT = 65_535;
const ROOT_ALLOWED_FILES = new Set([
  '.DS_Store',
  '.editorconfig',
  '.env',
  '.env.development',
  '.env.local',
  '.env.production',
  '.eslintignore',
  '.eslintrc',
  '.eslintrc.cjs',
  '.eslintrc.js',
  '.eslintrc.json',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc',
  '.prettierrc.cjs',
  '.prettierrc.js',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'LICENSE',
  'README',
  'README.md',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'requirements.txt',
  'yarn.lock',
]);
const ROOT_ALLOWED_DIR_PREFIXES = ['.'];
const ROOT_ALLOWED_DIRS = new Set([
  '.git',
  '.idea',
  '.vscode',
  '.github',
  '.husky',
  '.pnpm-store',
  '.turbo',
  '.next',
  'node_modules',
]);
const ROOT_OVERWRITABLE_FILES = new Set([
  '.gitignore',
  '.eslintignore',
  '.env',
  '.env.development',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  'README',
  'README.md',
  'README.txt',
]);

type PreviewStatus = 'starting' | 'running' | 'stopped' | 'error';

interface PreviewProcess {
  process: ChildProcess | null;
  port: number;
  url: string;
  status: PreviewStatus;
  logs: string[];
  startedAt: Date;
  lastAccessedAt: Date;
}

// Idle previews are evicted so the small port pool (e.g. 3710-3719) can't be
// permanently exhausted by dev servers from closed/crashed tabs. An open chat
// page heartbeats /preview/status, which keeps its preview warm.
const PREVIEW_IDLE_TIMEOUT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.PREVIEW_IDLE_TIMEOUT_MS || '', 10) || 20 * 60_000,
);
const PREVIEW_SWEEP_INTERVAL_MS = Math.max(
  10_000,
  Number.parseInt(process.env.PREVIEW_SWEEP_INTERVAL_MS || '', 10) || 5 * 60_000,
);

interface EnvOverrides {
  port?: number;
  url?: string;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

function parsePort(value?: string): number | null {
  if (!value) return null;
  const numeric = Number.parseInt(stripQuotes(value), 10);
  if (Number.isFinite(numeric) && numeric > 0 && numeric <= 65535) {
    return numeric;
  }
  return null;
}

async function readPackageJson(
  projectPath: string
): Promise<Record<string, any> | null> {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function collectEnvOverrides(projectPath: string): Promise<EnvOverrides> {
  const overrides: EnvOverrides = {};
  const files = ['.env.local', '.env'];

  for (const fileName of files) {
    const filePath = path.join(projectPath, fileName);
    try {
      const contents = await fs.readFile(filePath, 'utf8');
      const lines = contents.split(/\r?\n/);
      let candidateUrl: string | null = null;

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || !line.includes('=')) {
          continue;
        }

        const [rawKey, ...rawValueParts] = line.split('=');
        const key = rawKey.trim();
        const rawValue = rawValueParts.join('=');
        const value = stripQuotes(rawValue);

        if (!overrides.port && (key === 'PORT' || key === 'WEB_PORT')) {
          const parsed = parsePort(value);
          if (parsed) {
            overrides.port = parsed;
          }
        }

        if (!overrides.url && key === 'NEXT_PUBLIC_APP_URL' && value) {
          candidateUrl = value;
        }
      }

      if (!overrides.url && candidateUrl) {
        overrides.url = candidateUrl;
      }

      if (!overrides.port && overrides.url) {
        try {
          const parsedUrl = new URL(overrides.url);
          if (parsedUrl.port) {
            const parsedPort = parsePort(parsedUrl.port);
            if (parsedPort) {
              overrides.port = parsedPort;
            }
          }
        } catch {
          // Ignore invalid URL formats
        }
      }

      if (overrides.port && overrides.url) {
        break;
      }
    } catch {
      // Missing env file is fine; skip
    }
  }

  return overrides;
}

function resolvePreviewBounds(): { start: number; end: number } {
  const envStartRaw = Number.parseInt(process.env.PREVIEW_PORT_START || '', 10);
  const envEndRaw = Number.parseInt(process.env.PREVIEW_PORT_END || '', 10);

  const start = Number.isInteger(envStartRaw)
    ? Math.max(1, envStartRaw)
    : PREVIEW_FALLBACK_PORT_START;

  let end = Number.isInteger(envEndRaw)
    ? Math.min(PREVIEW_MAX_PORT, envEndRaw)
    : PREVIEW_FALLBACK_PORT_END;

  if (end < start) {
    end = Math.min(start + (PREVIEW_FALLBACK_PORT_END - PREVIEW_FALLBACK_PORT_START), PREVIEW_MAX_PORT);
  }

  return { start, end };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function parsePackageManagerField(value: unknown): PackageManagerId | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const [rawName] = value.split('@');
  const name = rawName.trim().toLowerCase();
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    return name as PackageManagerId;
  }
  return null;
}

function isCommandNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as NodeJS.ErrnoException;
  return err.code === 'ENOENT';
}

async function detectPackageManager(projectPath: string): Promise<PackageManagerId> {
  const packageJson = await readPackageJson(projectPath);
  const fromField = parsePackageManagerField(packageJson?.packageManager);
  if (fromField) {
    return fromField;
  }

  if (await fileExists(path.join(projectPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (await fileExists(path.join(projectPath, 'yarn.lock'))) {
    return 'yarn';
  }
  if (await fileExists(path.join(projectPath, 'bun.lockb'))) {
    return 'bun';
  }
  if (await fileExists(path.join(projectPath, 'package-lock.json'))) {
    return 'npm';
  }
  return 'npm';
}

async function runInstallWithPreferredManager(
  projectPath: string,
  env: NodeJS.ProcessEnv,
  logger: (chunk: Buffer | string) => void
): Promise<void> {
  const manager = await detectPackageManager(projectPath);
  const { command, installArgs } = PACKAGE_MANAGER_COMMANDS[manager];

  logger(`[PreviewManager] Installing dependencies using ${manager}.`);
  try {
    await appendCommandLogs(command, installArgs, projectPath, env, logger);
  } catch (error) {
    if (manager !== 'npm' && isCommandNotFound(error)) {
      logger(
        `[PreviewManager] ${command} unavailable. Falling back to npm install.`
      );
      await appendCommandLogs(
        PACKAGE_MANAGER_COMMANDS.npm.command,
        PACKAGE_MANAGER_COMMANDS.npm.installArgs,
        projectPath,
        env,
        logger
      );
      return;
    }
    throw error;
  }
}

async function isLikelyNextProject(dirPath: string): Promise<boolean> {
  const pkgPath = path.join(dirPath, 'package.json');
  try {
    const pkgRaw = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgRaw);
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    if (typeof deps.next === 'string') {
      return true;
    }
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      const scriptValues = Object.values(pkg.scripts as Record<string, unknown>);
      if (
        scriptValues.some(
          (value) =>
            typeof value === 'string' &&
            (value.includes('next dev') || value.includes('next start'))
        )
      ) {
        return true;
      }
    }
  } catch {
    // ignore
  }

  const configCandidates = [
    'next.config.js',
    'next.config.cjs',
    'next.config.mjs',
    'next.config.ts',
  ];
  for (const candidate of configCandidates) {
    if (await fileExists(path.join(dirPath, candidate))) {
      return true;
    }
  }

  const appDirCandidates = [
    'app',
    path.join('src', 'app'),
    'pages',
    path.join('src', 'pages'),
  ];
  for (const candidate of appDirCandidates) {
    if (await directoryExists(path.join(dirPath, candidate))) {
      return true;
    }
  }

  return false;
}

function isAllowedRootFile(name: string): boolean {
  if (ROOT_ALLOWED_FILES.has(name)) {
    return true;
  }
  if (name.endsWith('.md') || name.startsWith('.env.')) {
    return true;
  }
  return false;
}

function isAllowedRootDirectory(name: string): boolean {
  if (ROOT_ALLOWED_DIRS.has(name)) {
    return true;
  }
  return ROOT_ALLOWED_DIR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isOverwritableRootFile(name: string): boolean {
  if (ROOT_OVERWRITABLE_FILES.has(name)) {
    return true;
  }
  if (name.startsWith('.env.') || name.endsWith('.md')) {
    return true;
  }
  return false;
}

async function ensureProjectRootStructure(
  projectPath: string,
  log: (message: string) => void
): Promise<void> {
  const entries = await fs.readdir(projectPath, { withFileTypes: true });
  const hasRootPackageJson = entries.some(
    (entry) => entry.isFile() && entry.name === 'package.json'
  );
  if (hasRootPackageJson) {
    return;
  }

  const candidateDirs: { name: string; path: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === 'node_modules') {
      continue;
    }
    const dirPath = path.join(projectPath, entry.name);
    // quick skip for empty directory
    const isCandidate = await isLikelyNextProject(dirPath);
    if (isCandidate) {
      candidateDirs.push({ name: entry.name, path: dirPath });
    }
  }

  if (candidateDirs.length === 0) {
    return;
  }

  if (candidateDirs.length > 1) {
    const dirNames = candidateDirs.map((dir) => dir.name).join(', ');
    throw new Error(
      `Multiple potential Next.js projects detected in subdirectories (${dirNames}). Please move the desired project files to the project root.`
    );
  }

  const candidate = candidateDirs[0];
  const { name: nestedName, path: nestedPath } = candidate;

  for (const entry of entries) {
    if (entry.name === nestedName) {
      continue;
    }
    if (entry.isDirectory()) {
      if (!isAllowedRootDirectory(entry.name)) {
        throw new Error(
          `Cannot normalize project structure because directory "${entry.name}" exists alongside "${nestedName}". Move project files to the root manually.`
        );
      }
      continue;
    }

    if (!isAllowedRootFile(entry.name)) {
      throw new Error(
        `Cannot normalize project structure because file "${entry.name}" exists alongside "${nestedName}". Move project files to the root manually.`
      );
    }
  }

  // Remove nested node_modules and root node_modules (if any) to avoid conflicts during move.
  await fs.rm(path.join(nestedPath, 'node_modules'), { recursive: true, force: true });
  await fs.rm(path.join(projectPath, 'node_modules'), { recursive: true, force: true });

  const nestedEntries = await fs.readdir(nestedPath, { withFileTypes: true });
  for (const nestedEntry of nestedEntries) {
    const sourcePath = path.join(nestedPath, nestedEntry.name);
    const destinationPath = path.join(projectPath, nestedEntry.name);
    if (await pathExists(destinationPath)) {
      if (nestedEntry.isFile() && isOverwritableRootFile(nestedEntry.name)) {
        await fs.rm(destinationPath, { force: true });
        await fs.rename(sourcePath, destinationPath);
        log(
          `Replaced existing root file "${nestedEntry.name}" with the version from "${nestedName}".`
        );
        continue;
      }
      throw new Error(
        `Cannot move "${nestedEntry.name}" from "${nestedName}" because "${nestedEntry.name}" already exists in the project root.`
      );
    }
    await fs.rename(sourcePath, destinationPath);
  }

  await fs.rm(nestedPath, { recursive: true, force: true });
  log(
    `Detected Next.js project inside subdirectory "${nestedName}". Contents moved to the project root.`
  );
}

async function waitForPreviewReady(
  url: string,
  log: (chunk: Buffer | string) => void,
  timeoutMs = 60_000, // generous so a cold Angular/Next first build isn't cut off
  intervalMs = 1_000
) {
  const start = Date.now();
  let attempts = 0;

  // Per-attempt timeout so a hung connection can't block the readiness loop
  // beyond the overall budget.
  const fetchWithTimeout = (input: string, init?: RequestInit) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.min(intervalMs * 2, 5000));
    return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(t));
  };

  while (Date.now() - start < timeoutMs) {
    attempts += 1;
    try {
      const response = await fetchWithTimeout(url, { method: 'HEAD' });
      if (response.ok) {
        log(
          Buffer.from(
            `[PreviewManager] Preview server responded after ${attempts} attempt(s).`
          )
        );
        return true;
      }
      if (response.status === 405 || response.status === 501) {
        const getResponse = await fetchWithTimeout(url, { method: 'GET' });
        if (getResponse.ok) {
          log(
            Buffer.from(
              `[PreviewManager] Preview server responded to GET after ${attempts} attempt(s).`
            )
          );
          return true;
        }
      }
    } catch (error) {
      if (attempts === 1) {
        log(
          Buffer.from(
            `[PreviewManager] Waiting for preview server at ${url} (${error instanceof Error ? error.message : String(error)
            }).`
          )
        );
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  log(
    Buffer.from(
      `[PreviewManager] Preview server did not respond within ${timeoutMs}ms; continuing regardless.`
    )
  );
  return false;
}

async function appendCommandLogs(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logger: (chunk: Buffer | string) => void
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', logger);
    child.stderr?.on('data', logger);

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`${command} ${args.join(' ')} exited with code ${code}`)
        );
      }
    });
  });
}

async function ensureDependencies(
  projectPath: string,
  env: NodeJS.ProcessEnv,
  logger: (chunk: Buffer | string) => void
) {
  try {
    await fs.access(path.join(projectPath, 'node_modules'));
    return;
  } catch {
    // node_modules missing, fall back to npm install
  }

  await runInstallWithPreferredManager(projectPath, env, logger);
}

export interface PreviewInfo {
  port: number | null;
  url: string | null;
  status: PreviewStatus;
  logs: string[];
  pid?: number;
}

class PreviewManager {
  private processes = new Map<string, PreviewProcess>();
  private installing = new Map<string, Promise<void>>();
  // Serializes concurrent start() calls for the same project so two callers
  // can't both pass the "not running" check and spawn duplicate dev servers,
  // which would exhaust the preview port range and orphan processes.
  private starting = new Map<string, Promise<PreviewInfo>>();
  // Ports picked but whose dev server hasn't bound yet. Reserved atomically so two
  // concurrent starts can't land on the same port (a cross-project preview leak).
  private reservedPorts = new Set<number>();
  private reservedByProject = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Periodically reclaim ports held by previews nobody is watching anymore.
    this.sweepTimer = setInterval(() => this.evictIdle(), PREVIEW_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
    // On boot the process map is empty but the DB may hold previewUrl/previewPort
    // from before a restart — those servers are dead and their ports may be reused
    // by OTHER projects, so a stale URL could point at the wrong project. Clear them
    // and remove all stale per-project preview routes (dev servers are all dead).
    void clearAllPreviewState();
    void sweepPreviewRoutes();
  }

  /** Ports currently held (live processes) or reserved in-flight. */
  private usedPorts(): Set<number> {
    const s = new Set<number>(this.reservedPorts);
    for (const p of this.processes.values()) if (typeof p.port === 'number') s.add(p.port);
    return s;
  }

  /** Stop previews that haven't been accessed within the idle window. */
  private evictIdle(): void {
    const now = Date.now();
    for (const [projectId, p] of this.processes) {
      if (p.status === 'starting') continue;
      if (now - p.lastAccessedAt.getTime() > PREVIEW_IDLE_TIMEOUT_MS) {
        const idleMin = Math.round((now - p.lastAccessedAt.getTime()) / 60_000);
        console.log(`[PreviewManager] Evicting idle preview ${projectId} (idle ${idleMin}m, port ${p.port})`);
        this.stop(projectId).catch(() => {});
      }
    }
  }

  /** The least-recently-accessed running preview (for eviction when the pool is full). */
  private leastRecentlyUsed(): string | null {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [projectId, p] of this.processes) {
      if (p.status === 'starting') continue;
      const t = p.lastAccessedAt.getTime();
      if (t < oldestTime) {
        oldestTime = t;
        oldest = projectId;
      }
    }
    return oldest;
  }

  private getLogger(processInfo: PreviewProcess) {
    return (chunk: Buffer | string) => {
      const lines = chunk
        .toString()
        .split(/\r?\n/)
        .filter((line) => line.trim().length);
      lines.forEach((line) => {
        processInfo.logs.push(line);
        if (processInfo.logs.length > LOG_LIMIT) {
          processInfo.logs.shift();
        }
      });
    };
  }

  public async installDependencies(projectId: string): Promise<{ logs: string[] }> {
    const project = await getProjectById(projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    const projectPath = project.repoPath
      ? path.resolve(project.repoPath)
      : path.join(process.cwd(), 'projects', projectId);

    await fs.mkdir(projectPath, { recursive: true });

    const logs: string[] = [];
    const record = (message: string) => {
      const formatted = `[PreviewManager] ${message}`;
      console.log(formatted);
      logs.push(formatted);
    };

    await ensureProjectRootStructure(projectPath, record);

    try {
      await fs.access(path.join(projectPath, 'package.json'));
    } catch {
      const proj = await getProjectById(projectId).catch(() => null);
      record(`Bootstrapping ${stackKind(proj?.templateType)} app for project ${projectId}`);
      await scaffoldForStack(projectPath, projectId, proj?.templateType);
    }

    const hadNodeModules = await directoryExists(path.join(projectPath, 'node_modules'));

    const collectFromChunk = (chunk: Buffer | string) => {
      chunk
        .toString()
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .forEach((line) => record(line));
    };

    // Use a per-project lock to avoid concurrent install commands
    const runInstall = async () => {
      const installPromise = (async () => {
        try {
          const hasNodeModules = await directoryExists(path.join(projectPath, 'node_modules'));
          if (!hasNodeModules) {
            await runInstallWithPreferredManager(
              projectPath,
              { ...process.env },
              collectFromChunk
            );
          }
        } finally {
          this.installing.delete(projectId);
        }
      })();
      this.installing.set(projectId, installPromise);
      await installPromise;
    };

    // If an install is already in progress, wait for it; otherwise start one
    const existing = this.installing.get(projectId);
    if (existing) {
      record('Dependency installation already in progress; waiting for completion.');
      await existing;
    } else {
      await runInstall();
    }

    if (hadNodeModules) {
      record('Dependencies already installed. Skipped install command.');
    } else {
      record('Dependency installation completed.');
    }

    return { logs };
  }

  /**
   * The project's public preview URL WITHOUT waiting for the dev server to boot.
   * Only meaningful for the per-project-subdomain setup (PREVIEW_URL_TEMPLATE with
   * `{project}`), where the URL is deterministic and port-independent — so a
   * caller can return it immediately and warm the server in the background,
   * instead of blocking ~20-30s on a cold start. Returns null when the URL
   * depends on the assigned port (must start first to know it).
   */
  public deterministicPreviewUrl(projectId: string): string | null {
    const running = this.processes.get(projectId);
    if (running?.url) return running.url;
    const tmpl = process.env.PREVIEW_URL_TEMPLATE || '';
    if (tmpl.includes('{project}') && previewRouteDir()) return previewUrlFor(projectId, 0);
    return null;
  }

  public async start(projectId: string): Promise<PreviewInfo> {
    const existing = this.processes.get(projectId);
    if (existing && existing.status !== 'error') {
      existing.lastAccessedAt = new Date();
      return this.toInfo(existing);
    }

    // Coalesce concurrent starts: if one is already in flight, await it
    // instead of spawning a second dev server.
    const inFlight = this.starting.get(projectId);
    if (inFlight) {
      return inFlight;
    }

    const startPromise = this.startInternal(projectId).finally(() => {
      this.starting.delete(projectId);
      // Always release any in-flight port reservation (success or failure) so a
      // failed start can't permanently shrink the port pool.
      const rp = this.reservedByProject.get(projectId);
      if (rp !== undefined) { this.reservedPorts.delete(rp); this.reservedByProject.delete(projectId); }
    });
    this.starting.set(projectId, startPromise);
    return startPromise;
  }

  private async startInternal(projectId: string): Promise<PreviewInfo> {
    const project = await getProjectById(projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    const projectPath = project.repoPath
      ? path.resolve(project.repoPath)
      : path.join(process.cwd(), 'projects', projectId);

    await fs.mkdir(projectPath, { recursive: true });

    const pendingLogs: string[] = [];
    const queueLog = (message: string) => {
      const formatted = `[PreviewManager] ${message}`;
      console.log(formatted);
      pendingLogs.push(formatted);
    };

    await ensureProjectRootStructure(projectPath, queueLog);

    try {
      await fs.access(path.join(projectPath, 'package.json'));
    } catch {
      const proj = await getProjectById(projectId).catch(() => null);
      console.log(
        `[PreviewManager] Bootstrapping ${stackKind(proj?.templateType)} app for project ${projectId}`
      );
      await scaffoldForStack(projectPath, projectId, proj?.templateType);
    }

    // Make the preview report its route to the URL bar (cross-origin iframe).
    await ensurePreviewRouteReporter(projectPath, projectId);

    const previewBounds = resolvePreviewBounds();
    let preferredPort: number;
    try {
      // Exclude ports held by other live/starting previews so a concurrent start
      // can't pick the same one before this project's dev server binds.
      preferredPort = await findAvailablePort(previewBounds.start, previewBounds.end, this.usedPorts());
    } catch (poolFull) {
      // Pool exhausted — evict the least-recently-used preview to free a port,
      // then try once more.
      const victim = this.leastRecentlyUsed();
      if (!victim || victim === projectId) throw poolFull;
      console.log(`[PreviewManager] Port pool full; evicting LRU preview ${victim} to make room for ${projectId}`);
      await this.stop(victim).catch(() => {});
      preferredPort = await findAvailablePort(previewBounds.start, previewBounds.end, this.usedPorts());
    }
    // Guard the async gap: another concurrent start (different project) may have
    // reserved this port while findAvailablePort was probing. This check and the
    // reservation below are synchronous, so nothing can interleave between them.
    if (this.usedPorts().has(preferredPort)) {
      throw new Error(`Preview port ${preferredPort} was just claimed by another start; please retry.`);
    }
    // Reserve immediately (before the async spawn) so it's excluded from any
    // concurrent start until this project's process is registered below. Tracked
    // per-project so start()'s finally always releases it (success or failure).
    this.reservedPorts.add(preferredPort);
    this.reservedByProject.set(projectId, preferredPort);

    // When Claudable runs remotely (e.g. on a server), localhost:<port> is not
    // reachable from the user's browser. PREVIEW_URL_TEMPLATE (e.g.
    // "https://preview-{port}.example.com") yields a publicly-routed URL instead.
    const buildPreviewUrl = (port: number): string => previewUrlFor(projectId, port);

    const initialUrl = buildPreviewUrl(preferredPort);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // `next dev` must run in development; the Claudable container sets
      // NODE_ENV=production, which breaks the dev CSS loader (globals.css
      // "Module parse failed") and yields 500s in the preview.
      NODE_ENV: 'development',
      PORT: String(preferredPort),
      WEB_PORT: String(preferredPort),
      NEXT_PUBLIC_APP_URL: initialUrl,
    };

    // If a Postgres was provisioned for this project, expose DATABASE_URL to the
    // dev server so the generated app can talk to its database in the preview.
    try {
      const dbUrl = await getDatabaseUrl(projectId);
      if (dbUrl) env.DATABASE_URL = dbUrl;
    } catch { /* non-fatal */ }

    const previewProcess: PreviewProcess = {
      process: null,
      port: preferredPort,
      url: initialUrl,
      status: 'starting',
      logs: [],
      startedAt: new Date(),
      lastAccessedAt: new Date(),
    };

    const log = this.getLogger(previewProcess);
    const flushPendingLogs = () => {
      if (pendingLogs.length === 0) {
        return;
      }
      const entries = pendingLogs.splice(0);
      entries.forEach((entry) => log(Buffer.from(entry)));
    };
    flushPendingLogs();

    // Ensure dependencies with the same per-project lock used by installDependencies
    const ensureWithLock = async () => {
      // If node_modules exists, skip
      if (await directoryExists(path.join(projectPath, 'node_modules'))) {
        return;
      }
      const existing = this.installing.get(projectId);
      if (existing) {
        log(Buffer.from('[PreviewManager] Dependency installation already in progress; waiting...'));
        await existing;
        return;
      }
      const installPromise = (async () => {
        try {
          // Double-check just before install
          if (!(await directoryExists(path.join(projectPath, 'node_modules')))) {
            await runInstallWithPreferredManager(projectPath, env, log);
          }
        } finally {
          this.installing.delete(projectId);
        }
      })();
      this.installing.set(projectId, installPromise);
      await installPromise;
    };

    await ensureWithLock();

    const packageJson = await readPackageJson(projectPath);
    const hasPredev = Boolean(packageJson?.scripts?.predev);

    if (hasPredev) {
      await appendCommandLogs(npmCommand, ['run', 'predev'], projectPath, env, log);
    }

    const overrides = await collectEnvOverrides(projectPath);

    if (overrides.port) {
      if (
        overrides.port < previewBounds.start ||
        overrides.port > previewBounds.end
      ) {
        queueLog(
          `Ignoring project-specified port ${overrides.port} because it falls outside the allowed preview range ${previewBounds.start}-${previewBounds.end}.`
        );
        delete overrides.port;
      }
    }

    if (overrides.url) {
      try {
        const parsed = new URL(overrides.url);
        if (parsed.port) {
          const parsedPort = parsePort(parsed.port);
          if (
            parsedPort &&
            (parsedPort < previewBounds.start ||
              parsedPort > previewBounds.end)
          ) {
            queueLog(
              `Ignoring project-specified NEXT_PUBLIC_APP_URL (${overrides.url}) because port ${parsed.port} is outside the allowed preview range ${previewBounds.start}-${previewBounds.end}.`
            );
            delete overrides.url;
          }
        }
      } catch {
        queueLog(
          `Ignoring project-specified NEXT_PUBLIC_APP_URL (${overrides.url}) because it could not be parsed as a valid URL.`
        );
        delete overrides.url;
      }
    }

    flushPendingLogs();

    if (overrides.port && overrides.port !== previewProcess.port) {
      previewProcess.port = overrides.port;
      env.PORT = String(overrides.port);
      env.WEB_PORT = String(overrides.port);
      log(
        Buffer.from(
          `[PreviewManager] Detected project-specified port ${overrides.port}.`
        )
      );
    }

    const effectivePort = previewProcess.port;
    let resolvedUrl: string = buildPreviewUrl(effectivePort);
    if (typeof overrides.url === 'string' && overrides.url.trim().length > 0) {
      resolvedUrl = overrides.url.trim();
    }

    env.NEXT_PUBLIC_APP_URL = resolvedUrl;
    previewProcess.url = resolvedUrl;

    // Per-project mode: (re)write this project's Traefik route to the current port
    // so the stable subdomain always points at THIS project's dev server.
    if (perProjectPreview()) {
      await writePreviewRoute(projectId, effectivePort);
      // Pre-warm the LE cert in the background: the first HTTPS hit to a new
      // subdomain triggers DNS-01 issuance (~30-60s). Firing it now (non-blocking)
      // means the cert is usually ready by the time the user's browser loads.
      // Manual controller so the timer clears when the fetch settles (no lingering
      // 90s timer on the common warm-cert path).
      const warmCtrl = new AbortController();
      const warmTimer = setTimeout(() => warmCtrl.abort(), 90_000);
      void fetch(resolvedUrl, { method: 'HEAD', signal: warmCtrl.signal }).catch(() => {}).finally(() => clearTimeout(warmTimer));
    }

    // Bind to all interfaces when hosting remotely so the reverse proxy can
    // reach the dev server (network_mode host -> proxy hits it via the gateway).
    const bindHost = process.env.PREVIEW_BIND_HOST;
    const devArgs = ['run', 'dev', '--', '--port', String(effectivePort)];
    const previewProject = await getProjectById(projectId).catch(() => null);
    if (stackKind(previewProject?.templateType) === 'angular') {
      // Angular's dev server rejects unknown Host headers, and the preview is
      // reached via the public host — allow it explicitly. Derived from the
      // resolved URL (no infra domain hardcoded); honored by the v20 builder.
      try {
        const host = new URL(resolvedUrl).hostname;
        if (host) devArgs.push('--allowed-hosts', host);
      } catch {
        /* keep default args */
      }
    } else if (bindHost && bindHost.trim().length > 0) {
      devArgs.push('--hostname', bindHost.trim());
    }

    const child = spawn(
      npmCommand,
      devArgs,
      {
        cwd: projectPath,
        env,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group so we can kill the WHOLE tree (npm -> sh -> nuxt).
        // Killing just the parent left the nuxt child holding the port, leaking
        // a dev server on every restart.
        detached: process.platform !== 'win32',
      }
    );

    previewProcess.process = child;
    this.processes.set(projectId, previewProcess);
    // Now tracked via `processes` — free the in-flight reservation.
    this.reservedPorts.delete(preferredPort);

    child.stdout?.on('data', (chunk) => {
      log(chunk);
      try { recordBackendChunk(projectId, chunk, 'stdout'); } catch { /* diagnostics are best-effort */ }
      if (previewProcess.status === 'starting') {
        previewProcess.status = 'running';
      }
    });

    child.stderr?.on('data', (chunk) => {
      log(chunk);
      try { recordBackendChunk(projectId, chunk, 'stderr'); } catch { /* diagnostics are best-effort */ }
    });

    child.on('exit', (code, signal) => {
      previewProcess.status = code === 0 ? 'stopped' : 'error';
      this.processes.delete(projectId);
      // Withdraw the per-project route — a crash must not leave it pointing at a
      // now-dead port that another project can reuse (the cross-project leak).
      void removePreviewRoute(projectId).catch(() => {});
      updateProject(projectId, {
        previewUrl: null,
        previewPort: null,
      }).catch((error) => {
        console.error('[PreviewManager] Failed to reset project preview:', error);
      });
      updateProjectStatus(projectId, 'idle').catch((error) => {
        console.error('[PreviewManager] Failed to reset project status:', error);
      });
      log(
        Buffer.from(
          `Preview process exited (code: ${code ?? 'null'}, signal: ${
            signal ?? 'null'
          })`
        )
      );
    });

    child.on('error', (error) => {
      previewProcess.status = 'error';
      // Drop the dead entry so a subsequent start() isn't blocked by the
      // "already running" check at the top of start().
      if (this.processes.get(projectId) === previewProcess) {
        this.processes.delete(projectId);
      }
      void removePreviewRoute(projectId).catch(() => {});
      log(Buffer.from(`Preview process failed: ${error.message}`));
    });

    // Probe the LOCAL dev server for readiness — never the public URL. In
    // per-project mode the public URL is a fresh subdomain whose Let's Encrypt
    // cert issues on first access (DNS-01, ~30-60s); gating readiness on that
    // made cold starts appear to hang. The dev server is "ready" once it answers
    // locally; the cert/route warm up in parallel (pre-warmed below).
    const readinessUrl = `http://127.0.0.1:${effectivePort}`;
    const ready = await waitForPreviewReady(readinessUrl, log).catch(
      () => false
    );

    // The dev server exited (crash/build failure) while we were waiting.
    if (
      previewProcess.status === 'error' ||
      previewProcess.status === 'stopped'
    ) {
      await updateProject(projectId, {
        previewUrl: null,
        previewPort: null,
        status: 'idle',
      }).catch(() => {});
      throw new Error(
        'Preview server exited before it became reachable. Check the build logs.'
      );
    }

    // Clear the "starting" state regardless of whether the stdout fast-path
    // fired — otherwise a server that logs nothing leaves the UI spinning
    // forever. If the health check never passed we still mark it running
    // (dev servers can be slow behind a proxy) but log the discrepancy.
    if (previewProcess.status === 'starting') {
      previewProcess.status = 'running';
    }
    if (!ready) {
      log(
        Buffer.from(
          '[PreviewManager] Health check did not pass within the timeout; marking running optimistically (process is still alive).'
        )
      );
    }

    await updateProject(projectId, {
      previewUrl: previewProcess.url,
      previewPort: previewProcess.port,
      status: 'running',
    });

    return this.toInfo(previewProcess);
  }

  public async stop(projectId: string): Promise<PreviewInfo> {
    // Withdraw the project's preview route so its subdomain stops resolving to a
    // now-dead port (leaving it would 502; worse, the port could be reused).
    await removePreviewRoute(projectId);
    const processInfo = this.processes.get(projectId);
    if (!processInfo) {
      const project = await getProjectById(projectId);
      if (project) {
        await updateProject(projectId, {
          previewUrl: null,
          previewPort: null,
        });
        await updateProjectStatus(projectId, 'idle');
      }
      return {
        port: null,
        url: null,
        status: 'stopped',
        logs: [],
      };
    }

    try {
      killProcessTree(processInfo.process);
    } catch (error) {
      console.error('[PreviewManager] Failed to stop preview process:', error);
    }

    this.processes.delete(projectId);
    await updateProject(projectId, {
      previewUrl: null,
      previewPort: null,
    });
    await updateProjectStatus(projectId, 'idle');

    return {
      port: null,
      url: null,
      status: 'stopped',
      logs: processInfo.logs,
    };
  }

  public getStatus(projectId: string): PreviewInfo {
    const processInfo = this.processes.get(projectId);
    if (!processInfo) {
      return {
        port: null,
        url: null,
        status: 'stopped',
        logs: [],
      };
    }
    // A status read means someone's looking at this preview — keep it warm so the
    // idle sweep doesn't evict an actively-viewed preview.
    processInfo.lastAccessedAt = new Date();
    return this.toInfo(processInfo);
  }

  public getLogs(projectId: string): string[] {
    const processInfo = this.processes.get(projectId);
    return processInfo ? [...processInfo.logs] : [];
  }

  private toInfo(processInfo: PreviewProcess): PreviewInfo {
    return {
      port: processInfo.port,
      url: processInfo.url,
      status: processInfo.status,
      logs: [...processInfo.logs],
      pid: processInfo.process?.pid,
    };
  }
}

const globalPreviewManager = globalThis as unknown as {
  __claudable_preview_manager__?: PreviewManager;
};

export const previewManager: PreviewManager =
  globalPreviewManager.__claudable_preview_manager__ ??
  (globalPreviewManager.__claudable_preview_manager__ = new PreviewManager());
