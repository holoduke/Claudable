/**
 * Global session-expiry guard (client only).
 *
 * Before this, an expired session made every API call 401 and each screen just
 * showed its own "Failed …" toast. The guard wraps window.fetch once: a 401 from
 * an authenticated same-origin /api/* call sends the browser to
 * /login?callbackUrl=<current path> (once, debounced), so the user can sign in
 * again and land back where they were.
 *
 * It is a no-op when the auth gate is off (GET /api/auth/config says so) and
 * never fires for the auth endpoints themselves, the login page, or the public
 * guest surfaces (share links, /privacy), which are expected to 401 for
 * signed-out visitors.
 */

import { safeCallbackPath } from './safe-callback';

/** Pages that a signed-out visitor may legitimately be on. */
const PUBLIC_PAGE_PREFIXES = ['/login', '/share', '/privacy'];

/** API paths whose 401 is NOT a session expiry (or is expected for guests). */
const IGNORED_API_PATTERNS: RegExp[] = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/share(\/|$)/,
  /^\/api\/health$/,
  /^\/api\/agent-mcp\//,
  /^\/api\/mcp-oauth\/callback$/,
  // Guest review endpoints authorize themselves via X-Share-Token.
  /^\/api\/projects\/[^/]+\/(comments|client-logs)(\/|$)/,
];

export function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export interface UnauthorizedDecisionInput {
  /** Absolute or relative URL of the request. */
  requestUrl: string;
  status: number;
  /** window.location.origin */
  origin: string;
  /** window.location.pathname of the page that made the call. */
  pathname: string;
  authEnabled: boolean;
}

/** Pure decision: should this response send the user to the login page? */
export function shouldRedirectOnUnauthorized(input: UnauthorizedDecisionInput): boolean {
  if (!input.authEnabled || input.status !== 401) return false;
  if (isPublicPage(input.pathname)) return false;
  let url: URL;
  try {
    url = new URL(input.requestUrl, input.origin);
  } catch {
    return false;
  }
  if (url.origin !== input.origin) return false;
  if (!url.pathname.startsWith('/api/')) return false;
  return !IGNORED_API_PATTERNS.some((re) => re.test(url.pathname));
}

/** /login?callbackUrl=<path+query+hash> — only same-site relative paths. */
export function buildLoginUrl(pathname: string, search = '', hash = ''): string {
  const target = `${pathname || '/'}${search}${hash}`;
  // Validate with the same rules the login page applies, but keep the raw
  // (still-encoded) target so it isn't decoded twice on the way back.
  const safe = safeCallbackPath(target, '') ? target : '/';
  return `/login?callbackUrl=${encodeURIComponent(safe)}`;
}

function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

let authEnabledPromise: Promise<boolean> | null = null;

/**
 * Whether the auth gate is on, from the public GET /api/auth/config. Cached for
 * the page's lifetime; a failed lookup resolves false (stay a no-op) and is
 * retried on the next call.
 */
export function fetchAuthEnabled(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!authEnabledPromise) {
    authEnabledPromise = fetchImpl('/api/auth/config', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.data?.authEnabled === true)
      .catch(() => {
        authEnabledPromise = null;
        return false;
      });
  }
  return authEnabledPromise;
}

const INSTALLED = Symbol.for('claudable.sessionGuard');

/**
 * Wrap window.fetch once. Returns an uninstall function (used by tests and the
 * provider's cleanup). Installing twice is a no-op.
 */
export function installSessionGuard(win: Window = window): () => void {
  const w = win as Window & { [INSTALLED]?: boolean };
  if (w[INSTALLED]) return () => {};
  const original = w.fetch.bind(w);
  let redirecting = false;

  const guarded: typeof fetch = async (input, init) => {
    const response = await original(input, init);
    if (response.status !== 401 || redirecting) return response;
    const { origin, pathname, search, hash } = w.location;
    // Cheap pre-check without auth state, then confirm the gate is on.
    const base = { requestUrl: requestUrlOf(input), status: 401, origin, pathname };
    if (!shouldRedirectOnUnauthorized({ ...base, authEnabled: true })) return response;
    void fetchAuthEnabled(original).then((enabled) => {
      if (!enabled || redirecting) return;
      redirecting = true;
      w.location.assign(buildLoginUrl(pathname, search, hash));
    });
    return response;
  };

  w.fetch = guarded;
  w[INSTALLED] = true;
  return () => {
    if (w.fetch === guarded) w.fetch = original;
    w[INSTALLED] = false;
  };
}
