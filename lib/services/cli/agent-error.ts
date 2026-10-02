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
  // Docker daemon / client failures while starting the agent container
  // (e.g. "docker: Error response from daemon: network … not found").
  /Error response from daemon/i,
  /Cannot connect to the Docker daemon/i,
  /^\s*docker:/im,
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
  if (/spawn|ENOENT|Error response from daemon|Cannot connect to the Docker daemon|^\s*docker:/im.test(text)) {
    return 'agent-start-failed';
  }
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

/**
 * Raised when a resumed turn failed BEFORE producing any assistant/tool output
 * (stale or missing session, CLI refused to resume, container never started):
 * the request row is left non-terminal on purpose, and the caller retries the
 * instruction once in a fresh session. Any other failure is surfaced to the
 * user directly and must NOT be retried — the agent may already have edited.
 */
export class AgentResumeRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentResumeRetryableError';
  }
}

/** Friendly chat text for a CLI/SDK `result` event whose subtype is not 'success'. */
export function describeFailedResultSubtype(subtype: string | undefined): string {
  switch (subtype) {
    case 'error_max_turns':
      return 'The agent stopped because it reached the maximum number of steps for one turn. ' +
        'Its changes so far are kept — send "continue" to let it pick up where it left off.';
    case 'error_max_budget_usd':
      return 'The agent stopped because this run reached its spending limit.';
    case 'error_during_execution':
      return 'The agent run failed while it was working. Changes made before the failure are kept — ' +
        'check the preview, then send your message again (or "continue") to finish.';
    default:
      return subtype
        ? `The agent run did not finish successfully (${subtype}). Please try again.`
        : 'The agent run did not finish successfully. Please try again.';
  }
}
