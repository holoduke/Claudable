import { describe, expect, it } from 'vitest';
import {
  RENDER_WINDOW_BASE,
  windowOffset,
  nextRenderLimit,
  revealsFromMemory,
} from './chat-window';

describe('windowOffset', () => {
  it('hides nothing while the list fits the window', () => {
    expect(windowOffset(10, 50)).toBe(0);
    expect(windowOffset(50, 50)).toBe(0);
  });

  it('hides the overflow at the start of the list', () => {
    expect(windowOffset(771, 50)).toBe(721);
  });
});

describe('nextRenderLimit', () => {
  const base = { grew: 1, prepended: false, stickToBottom: true, current: RENDER_WINDOW_BASE };

  it('keeps the window at its base while following the stream', () => {
    // The whole point: a 700-message session still mounts only the newest slice.
    expect(nextRenderLimit({ ...base, current: RENDER_WINDOW_BASE })).toBe(RENDER_WINDOW_BASE);
  });

  it('collapses an expanded window once the user is following again', () => {
    expect(nextRenderLimit({ ...base, current: 300 })).toBe(RENDER_WINDOW_BASE);
  });

  it('grows instead of sliding while the user reads history', () => {
    // Sliding here would unmount the text under their eyes — the actual bug.
    expect(nextRenderLimit({ ...base, stickToBottom: false, current: 120, grew: 3 })).toBe(123);
  });

  it('reveals fetched history rather than collapsing it away', () => {
    // A fetch prepends 100 older messages; collapsing would discard the click.
    expect(nextRenderLimit({ grew: 100, prepended: true, stickToBottom: true, current: 50 })).toBe(150);
  });

  it('is a no-op when nothing was added', () => {
    expect(nextRenderLimit({ ...base, grew: 0, current: 120 })).toBe(120);
    expect(nextRenderLimit({ ...base, grew: -5, current: 120 })).toBe(120);
  });
});

describe('revealsFromMemory', () => {
  it('prefers memory while the window hides something', () => {
    expect(revealsFromMemory(200, 50)).toBe(true);
  });

  it('falls through to the server once the window covers everything', () => {
    expect(revealsFromMemory(50, 50)).toBe(false);
    expect(revealsFromMemory(20, 50)).toBe(false);
  });
});
