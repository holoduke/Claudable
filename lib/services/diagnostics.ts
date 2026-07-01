/**
 * Per-project runtime diagnostics — a live picture of "what's broken in this app
 * right now" that the agent can query to self-diagnose and fix.
 *
 * Two sources feed capped in-memory ring buffers, keyed by projectId:
 *  - `console`  — browser console errors/warnings + uncaught errors, shipped by
 *                 the injected preview plugin (see preview.ts) to /client-logs.
 *  - `backend`  — Nuxt/nitro dev-server errors, tapped from the preview process
 *                 stderr in PreviewManager.
 *
 * In-memory only (like the preview process table) — diagnostics are about the
 * currently-running app, so they reset with the container, which is fine.
 */

export type DiagSource = 'console' | 'backend';

export interface DiagEntry {
  source: DiagSource;
  level: string; // 'error' | 'warn' | 'log' | 'info'
  message: string;
  at: string; // origin hint: "file:line", a URL, or ''
  ts: number; // epoch ms
}

const CAP_PER_PROJECT = 150;
const MAX_PROJECTS = 40; // bound total memory: evict the oldest project's buffer past this
const buffers = new Map<string, DiagEntry[]>();

function push(projectId: string, entry: DiagEntry): void {
  // Bound how many projects we retain (buffers are never explicitly cleared on
  // preview stop). Map preserves insertion order → drop the oldest.
  if (!buffers.has(projectId) && buffers.size >= MAX_PROJECTS) {
    const oldest = buffers.keys().next().value;
    if (oldest !== undefined) buffers.delete(oldest);
  }
  const buf = buffers.get(projectId) ?? [];
  // Collapse consecutive duplicates (same source+message) into the latest.
  const last = buf[buf.length - 1];
  if (last && last.source === entry.source && last.message === entry.message) {
    last.ts = entry.ts;
    last.at = entry.at || last.at;
  } else {
    buf.push(entry);
    if (buf.length > CAP_PER_PROJECT) buf.splice(0, buf.length - CAP_PER_PROJECT);
  }
  buffers.set(projectId, buf);
}

/** Ingest a batch of browser-console entries shipped by the preview plugin. */
export function recordConsole(
  projectId: string,
  entries: Array<{ level?: unknown; message?: unknown; at?: unknown }>,
): number {
  let n = 0;
  for (const e of entries.slice(0, 50)) {
    const message = typeof e.message === 'string' ? e.message.trim().slice(0, 800) : '';
    if (!message) continue;
    const level = e.level === 'warn' || e.level === 'info' || e.level === 'log' ? e.level : 'error';
    push(projectId, { source: 'console', level, message, at: typeof e.at === 'string' ? e.at.slice(0, 200) : '', ts: nowMs() });
    n += 1;
  }
  return n;
}

const BACKEND_INTERESTING = /error|warn|fail|cannot|undefined|not a function|unexpected|exception|ERR_|✖|✗|✘|\[nuxt\]|\[nitro\]|\[vite\]/iu;
const BACKEND_NOISE = /webpack|hmr update|hot updated|\bwaiting for\b|➜|listening on|ready in|compiled|✔|✓|clnt/iu;

/** Tap a chunk of dev-server output; records only lines that look like problems. */
export function recordBackendChunk(projectId: string, chunk: Buffer | string, stream: 'stdout' | 'stderr'): void {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  for (const raw of text.split(/\r?\n/u)) {
    // Strip ANSI colour codes the dev server emits.
    const line = raw.replace(/\[[0-9;]*m/gu, '').trim();
    if (!line || line.length < 3) continue;
    if (BACKEND_NOISE.test(line) && !/error|exception|fail/iu.test(line)) continue;
    if (stream === 'stdout' && !BACKEND_INTERESTING.test(line)) continue; // stdout: only the interesting bits
    const level = /error|exception|✖|✗|✘|ERR_|fail/iu.test(line) ? 'error' : 'warn';
    push(projectId, { source: 'backend', level, message: line.slice(0, 800), at: stream, ts: nowMs() });
  }
}

export interface DiagnosticsSummary {
  entries: DiagEntry[];
  counts: { console: number; backend: number; errors: number; warnings: number };
}

/** Recent diagnostics, newest last. `onlyErrors` drops warn/info/log. */
export function getDiagnostics(projectId: string, opts?: { limit?: number; onlyErrors?: boolean }): DiagnosticsSummary {
  const all = buffers.get(projectId) ?? [];
  const filtered = opts?.onlyErrors ? all.filter((e) => e.level === 'error') : all;
  const limit = Math.max(1, Math.min(opts?.limit ?? 60, CAP_PER_PROJECT));
  const entries = filtered.slice(-limit);
  return {
    entries,
    counts: {
      console: all.filter((e) => e.source === 'console').length,
      backend: all.filter((e) => e.source === 'backend').length,
      errors: all.filter((e) => e.level === 'error').length,
      warnings: all.filter((e) => e.level === 'warn').length,
    },
  };
}

export function clearDiagnostics(projectId: string): void {
  buffers.delete(projectId);
}

// Isolated so the Date.now() lint (workflow scripts ban it) has a single site.
function nowMs(): number {
  return Date.now();
}
