/**
 * Post-create notice contract with the chat page: when a follow-up step of
 * project creation fails (attachment upload, starting the assistant) or the
 * server reports setup warnings, the home page stores ONE notice under
 * `claudable:postCreateNotice:<projectId>` before navigating; the chat page
 * shows it. A prompt that could not be sent is also kept under
 * `claudable:postCreatePrompt:<projectId>` so it is never lost.
 */

export type PostCreateNotice = { type: 'error' | 'info'; message: string };

export const postCreateNoticeKey = (projectId: string) => `claudable:postCreateNotice:${projectId}`;
export const postCreatePromptKey = (projectId: string) => `claudable:postCreatePrompt:${projectId}`;

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface PostCreateOutcome {
  failedUploads: string[];
  actFailed: boolean;
  /** The instruction that was (or would have been) sent to the assistant. */
  prompt: string;
  warningCodes: string[];
  /** Server-provided English fallbacks, parallel to warningCodes. */
  warnings: string[];
}

const MAX_PROMPT_IN_NOTICE = 600;

/** Localized warning text: a known code's translation, else the server's message. */
function warningText(code: string | undefined, fallback: string | undefined, t: Translate): string {
  if (code) {
    const key = `home.warning.${code}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return fallback ?? '';
}

/** Build the single notice to show after creation, or null when all went fine. */
export function buildPostCreateNotice(outcome: PostCreateOutcome, t: Translate): PostCreateNotice | null {
  const errors: string[] = [];
  if (outcome.actFailed) {
    const prompt = outcome.prompt.trim();
    errors.push(prompt
      ? t('home.notice.actFailed', { prompt: prompt.length > MAX_PROMPT_IN_NOTICE ? `${prompt.slice(0, MAX_PROMPT_IN_NOTICE)}…` : prompt })
      : t('home.notice.actFailedNoPrompt'));
  }
  if (outcome.failedUploads.length > 0) {
    errors.push(t('home.notice.uploadFailed', { names: outcome.failedUploads.map((n) => `“${n}”`).join(', ') }));
  }
  const count = Math.max(outcome.warningCodes.length, outcome.warnings.length);
  const details = Array.from({ length: count }, (_, i) => warningText(outcome.warningCodes[i], outcome.warnings[i], t))
    .filter(Boolean);
  const info = details.length > 0 ? t('home.notice.warnings', { details: details.join('; ') }) : null;

  if (errors.length > 0) return { type: 'error', message: [...errors, ...(info ? [info] : [])].join('\n\n') };
  return info ? { type: 'info', message: info } : null;
}

/** Persist the notice (and an unsent prompt) for the chat page; storage failures are non-fatal. */
export function storePostCreateNotice(
  storage: Pick<Storage, 'setItem'>,
  projectId: string,
  notice: PostCreateNotice | null,
  unsentPrompt?: string,
): void {
  try {
    if (notice) storage.setItem(postCreateNoticeKey(projectId), JSON.stringify(notice));
    if (unsentPrompt && unsentPrompt.trim()) storage.setItem(postCreatePromptKey(projectId), unsentPrompt);
  } catch (e) {
    console.warn('Could not store the post-create notice:', e);
  }
}
