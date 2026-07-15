/**
 * Body-size guarding for Route Handlers. Next.js App Router imposes no default
 * body-size limit on request.json(), so a large body would buffer fully into the
 * shared control-plane process (OOM/DoS). A Content-Length check alone is
 * bypassable (chunked transfer or an omitted header), so `readJsonCapped` also
 * enforces a HARD ceiling by streaming the body and aborting once it's exceeded —
 * it never buffers more than `maxBytes`.
 */

/** Thrown by readJsonCapped when the body exceeds the cap. Callers map it to 413. */
export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'BodyTooLargeError';
  }
}

/** JSON control payloads (ids + short text) — generous but bounded. */
export const SMALL_JSON_LIMIT = 256 * 1024;

/**
 * Read and JSON-parse a request body with a hard `maxBytes` ceiling enforced by
 * streaming (not just Content-Length). Throws BodyTooLargeError as soon as the
 * accumulated bytes exceed the cap, cancelling the stream so nothing unbounded is
 * buffered. Returns `{}` for an empty body and `null` for a non-JSON body (callers
 * then validate individual fields).
 */
export async function readJsonCapped(request: Request, maxBytes: number): Promise<unknown> {
  // Fast reject on an honest, oversized Content-Length (avoids reading at all).
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();

  const stream = request.body;
  if (!stream) return {};

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let res: ReadableStreamReadResult<Uint8Array>;
    try {
      res = await reader.read();
    } catch {
      break; // client abort / network error mid-body — use whatever arrived (likely nothing)
    }
    if (res.done) break;
    const value = res.value;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }

  if (total === 0) return {};
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
