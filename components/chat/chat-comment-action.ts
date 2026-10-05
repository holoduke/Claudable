/**
 * Result contract for comment actions (create / resolve / delete) handed to
 * CommentsLayer by its parent:
 * - `true`, `undefined` (void) or `{ ok: true }` → success
 * - `false` → failure, show the generic fallback message
 * - a non-empty string or `{ ok: false, message }` → failure, show that server message
 */
export type CommentActionResult = boolean | string | void | undefined | { ok: boolean; message?: string | null };

/** Returns the message to show for a failed action, or null on success. */
export function commentActionError(result: CommentActionResult, fallback: string): string | null {
  if (result === undefined || result === true) return null;
  if (result === false) return fallback;
  if (typeof result === 'string') return result.trim() || fallback;
  if (typeof result === 'object' && result !== null) {
    if (result.ok) return null;
    return result.message?.trim() || fallback;
  }
  return null;
}
