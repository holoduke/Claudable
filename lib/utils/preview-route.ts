/**
 * Canonical form of a preview route as used for the URL bar and for scoping
 * review comments: pathname only (no query string or hash — e.g. the chat
 * page's `?_ts=` cache-buster must never leak into a stored route), always a
 * leading "/", no trailing slash except for the root, no repeated slashes.
 * Safe on both client and server (no Node/DOM dependencies).
 */
export function normalizePreviewRoute(raw: unknown): string {
  if (typeof raw !== 'string') return '/';
  let p = raw.trim();
  // An absolute URL (defensive — the plugin posts a path) → keep its path.
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(p)) {
    try { p = new URL(p).pathname; } catch { return '/'; }
  }
  const cut = p.search(/[?#]/u);
  if (cut !== -1) p = p.slice(0, cut);
  p = p.replace(/\/{2,}/gu, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/u, '') || '/';
  return p;
}
