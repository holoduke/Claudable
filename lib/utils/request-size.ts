/**
 * Cheap pre-parse body-size guard. Next.js App Router Route Handlers impose no
 * default body-size limit on request.json(), so a large body would buffer fully
 * into the shared control-plane process. This rejects oversized requests by
 * Content-Length before parsing. (A client omitting Content-Length via chunked
 * transfer can still bypass it — the fronting proxy / container memory limit is
 * the backstop there; this closes the common case cheaply.)
 */
export function bodyTooLarge(request: Request, maxBytes: number): boolean {
  const len = Number(request.headers.get('content-length') || 0);
  return Number.isFinite(len) && len > maxBytes;
}

/** JSON control payloads (ids + short text) — generous but bounded. */
export const SMALL_JSON_LIMIT = 256 * 1024;
