/**
 * One-shot notice the home page leaves in sessionStorage after creating a
 * project (e.g. "created, but the repo could not be set up"). The chat page
 * shows it once on mount and removes it.
 */
export const POST_CREATE_NOTICE_PREFIX = 'claudable:postCreateNotice:';

export interface PostCreateNotice {
  type: 'error' | 'info';
  message: string;
}

export function readPostCreateNotice(raw: string | null): PostCreateNotice | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { type, message } = parsed as Record<string, unknown>;
    if ((type !== 'error' && type !== 'info') || typeof message !== 'string' || !message.trim()) return null;
    return { type, message: message.trim() };
  } catch {
    return null;
  }
}
