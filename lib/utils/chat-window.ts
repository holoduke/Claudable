/**
 * Render-window math for the chat log.
 *
 * A long-lived session accumulates hundreds of messages (mostly tool blocks).
 * Mounting them all builds a DOM tens of thousands of pixels tall, and every
 * streamed message then re-lays-out that whole tree — which is what makes the
 * view judder and shift while an agent is working. So only the newest slice is
 * mounted; the rest stay in memory and come back by widening the window.
 *
 * The rules live here as pure functions so they can be reasoned about (and
 * tested) without a DOM.
 */

/** Default number of newest messages kept mounted. */
export const RENDER_WINDOW_BASE = 50;
/** How much one "load older" click reveals from memory. */
export const RENDER_WINDOW_STEP = 50;

/** How many messages the window hides at the START of the list. */
export function windowOffset(total: number, limit: number): number {
  return Math.max(0, total - limit);
}

export interface WindowGrowthInput {
  /** How many messages were added since the previous render (> 0). */
  grew: number;
  /** The addition came from a history FETCH (older messages, at the top). */
  prepended: boolean;
  /** The user is following the stream at the bottom (not reading history). */
  stickToBottom: boolean;
  /** The current window size. */
  current: number;
}

/**
 * The window size after messages were added.
 *
 *  - fetched history → grow, so what the user asked for is actually mounted;
 *  - streamed message while they scrolled up → grow, so the text under their
 *    eyes doesn't shift when the oldest mounted message would drop off;
 *  - streamed message while they're following → collapse to the base size,
 *    which is what keeps the DOM (and the jank) bounded.
 */
export function nextRenderLimit(input: WindowGrowthInput): number {
  const { grew, prepended, stickToBottom, current } = input;
  if (grew <= 0) return current;
  if (prepended) return current + grew;
  return stickToBottom ? RENDER_WINDOW_BASE : current + grew;
}

/**
 * Does "load older" have anything to reveal from memory, or must it ask the
 * server? Widening the window is instant, so it always goes first.
 */
export function revealsFromMemory(total: number, limit: number): boolean {
  return total > limit;
}
