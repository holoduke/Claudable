/**
 * Small pure helpers for the home (start) screen — kept out of app/page.tsx so
 * they can be unit-tested.
 */

const MAX_NAME = 50;

/** A file name without its (last) extension: "Brief v2.final.pdf" → "Brief v2.final". */
export function stripExtension(fileName: string): string {
  const base = fileName.trim();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The name for a new project: the prompt (truncated), else the first
 * attachment's file name without extension, else `fallback` (a translated
 * "Untitled project"). Never empty — the API rejects an empty name.
 */
export function deriveProjectName(prompt: string, attachmentNames: string[], fallback: string): string {
  const p = prompt.trim();
  if (p) return p.length > MAX_NAME ? `${p.slice(0, MAX_NAME)}...` : p;
  const first = attachmentNames.map(stripExtension).find((n) => n.trim());
  if (first) return first.length > MAX_NAME ? `${first.slice(0, MAX_NAME)}...` : first;
  return fallback;
}

/**
 * The human message from an API error body ({ success:false, error, message }):
 * `message` first (the readable sentence), then `error` (a code or short text),
 * then the generic fallback. Generic 5xx placeholders are not worth showing.
 */
export function apiErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const b = body as { message?: unknown; error?: unknown };
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() && v !== 'Internal server error' ? v.trim() : '');
  return pick(b.message) || pick(b.error) || fallback;
}
