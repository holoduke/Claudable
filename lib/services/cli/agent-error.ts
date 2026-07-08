/**
 * Maps raw agent-turn failures to messages fit for the chat log.
 *
 * A failed spawn or crashed CLI surfaces as a Node stack trace (often a
 * mid-line tail, because the container runner keeps only the last 500 chars
 * of stderr). Dumping that into the chat reads as gibberish to the user, so:
 * technical noise becomes a short, friendly message with a stable reference
 * code, while messages that are already human-readable pass through
 * unchanged. Full raw detail must stay in the server logs — callers log it
 * BEFORE mapping.
 */

const NOISE_PATTERNS: RegExp[] = [
  /node:internal\//,
  /MODULE_NOT_FOUND/,
  /Cannot find module/,
  /requireStack/,
  /^\s*at\s+.+\(.+:\d+:\d+\)\s*$/m, // stack frames ("    at fn (file:1:2)")
  /^\s*Error: spawn\b/m,
];

/** True when the text is a stack trace / Node internals dump rather than a
 *  message written for humans. */
export function isTechnicalNoise(text: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Stable reference codes so an admin can grep the server logs for the
 *  matching raw error. */
function classifyCause(text: string): string {
  if (/MODULE_NOT_FOUND|Cannot find module/.test(text)) return 'agent-component-missing';
  if (/spawn|ENOENT/.test(text)) return 'agent-start-failed';
  if (/heap out of memory|ENOMEM|OOM/i.test(text)) return 'agent-out-of-memory';
  return 'agent-internal-error';
}

const GENERIC_MESSAGE =
  'The agent run failed because of an internal error on the server. ' +
  'Please try sending your message again — if it keeps happening, ask an ' +
  'admin to check the server logs';

/**
 * Returns a chat-safe error message. Human-readable input is returned
 * unchanged; stack traces and other technical noise are replaced by a
 * friendly message carrying a reference code for the server logs.
 */
export function toUserFacingAgentError(raw: string | null | undefined): string {
  const message = (raw ?? '').trim();
  if (!message) return `${GENERIC_MESSAGE} (ref: agent-internal-error).`;
  if (!isTechnicalNoise(message)) return message;
  return `${GENERIC_MESSAGE} (ref: ${classifyCause(message)}).`;
}
