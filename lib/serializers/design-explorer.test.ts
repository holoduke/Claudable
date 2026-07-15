import { describe, expect, it } from 'vitest';
import { serializeDesignFrame, serializeDesignCanvas } from './design-explorer';

function frame(over: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    canvasId: 'c1',
    styleId: 'editorial',
    styleName: 'Editorial',
    prompt: 'a blog',
    htmlPath: '/data/design-canvases/c1/f1/index.html',
    status: 'ready',
    errorText: null,
    version: 1,
    parentFrameId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...over,
  } as never;
}

describe('serializeDesignFrame', () => {
  it('exposes hasHtml (never the on-disk htmlPath) and ISO dates', () => {
    const s = serializeDesignFrame(frame());
    expect(s.hasHtml).toBe(true);
    expect((s as Record<string, unknown>).htmlPath).toBeUndefined();
    expect(s.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(s.updatedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('hasHtml is false unless status is ready AND htmlPath is set', () => {
    expect(serializeDesignFrame(frame({ status: 'generating' })).hasHtml).toBe(false);
    expect(serializeDesignFrame(frame({ htmlPath: null })).hasHtml).toBe(false);
    expect(serializeDesignFrame(frame({ status: 'error', errorText: 'boom' })).hasHtml).toBe(false);
  });

  it('normalizes nullable relations', () => {
    const s = serializeDesignFrame(frame({ styleId: null, styleName: null, parentFrameId: 'p1' }));
    expect(s.styleId).toBe(null);
    expect(s.parentFrameId).toBe('p1');
  });
});

describe('serializeDesignCanvas', () => {
  it('serializes frames and defaults an absent frames array to []', () => {
    const base = {
      id: 'c1', projectId: 'p1', title: 'x', prompt: 'x', status: 'ready',
      createdById: null, createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as never;
    expect(serializeDesignCanvas(base).frames).toEqual([]);
    const withFrames = serializeDesignCanvas({ ...(base as object), frames: [frame()] } as never);
    expect(withFrames.frames).toHaveLength(1);
    expect(withFrames.frames[0].id).toBe('f1');
  });
});
