/**
 * Helpers for surfacing chat-send failures (POST /api/chat/:id/act) to the user
 * and for pacing queued-message retries when the server reports "busy".
 */

/**
 * The human-readable reason from an API error body: `message`, then `error`,
 * then the HTTP status line. Non-JSON bodies fall back to the status line.
 */
export function extractErrorMessage(bodyText: string, status: number, statusText: string): string {
  const fallback = `${status}${statusText ? ` ${statusText}` : ''}`;
  if (!bodyText) return fallback;
  try {
    const j: unknown = JSON.parse(bodyText);
    if (j && typeof j === 'object') {
      const { message, error } = j as { message?: unknown; error?: unknown };
      if (typeof message === 'string' && message.trim()) return message.trim();
      if (typeof error === 'string' && error.trim()) return error.trim();
    }
  } catch { /* not JSON */ }
  return fallback;
}

/** Read a failed Response's body and return {@link extractErrorMessage}. */
export async function readSendError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return extractErrorMessage(text, res.status, res.statusText);
}

/**
 * A 409 normally means "another turn is running" (transient → retry later).
 * A 409 because the project is being deleted is permanent and must surface.
 */
export function isHardBusyError(message: string): boolean {
  return /being deleted/iu.test(message);
}

const QUEUE_RETRY_DELAYS_MS = [1500, 3000, 5000, 8000, 10000] as const;

/** Backoff before re-trying a queued message the server rejected as busy. */
export function queueRetryDelayMs(attempt: number): number {
  const i = Math.max(0, Math.min(Math.floor(attempt), QUEUE_RETRY_DELAYS_MS.length - 1));
  return QUEUE_RETRY_DELAYS_MS[i];
}
