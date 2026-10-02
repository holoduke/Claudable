/**
 * Turn an API error body into text a user can read.
 *
 * Our routes put a machine code in `error` ("forbidden", "action_failed") and
 * the human sentence in `message` (lib/auth/gate.ts deny(),
 * lib/utils/api-response.ts createErrorResponse). Older routes only set
 * `error`, sometimes as a sentence. So: prefer `message`, then `error` unless
 * it is just a code, then the caller's fallback.
 */

/** snake/kebab-case identifiers without spaces, e.g. "not_found". */
const MACHINE_CODE_RE = /^[a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*$/;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function apiErrorMessage(json: unknown, fallback: string): string {
  if (!json || typeof json !== 'object') return nonEmptyString(json) ?? fallback;
  const body = json as Record<string, unknown>;

  const message = nonEmptyString(body.message);
  if (message) return message;

  const nested = body.error && typeof body.error === 'object'
    ? nonEmptyString((body.error as Record<string, unknown>).message)
    : null;
  if (nested) return nested;

  const error = nonEmptyString(body.error);
  if (error && !MACHINE_CODE_RE.test(error)) return error;

  return fallback;
}

/**
 * Read a failed Response's body (JSON or not) and return a readable message.
 * Never throws; falls back to `fallback` or "Request failed (<status>)".
 */
export async function responseErrorMessage(res: Response, fallback?: string): Promise<string> {
  const fb = fallback ?? `Request failed (${res.status})`;
  try {
    const text = await res.text();
    if (!text) return fb;
    try {
      return apiErrorMessage(JSON.parse(text), fb);
    } catch {
      // Non-JSON body (HTML error page, proxy text) — never show raw markup.
      return fb;
    }
  } catch {
    return fb;
  }
}
