import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveShareToken = vi.fn();
const getStatus = vi.fn();
vi.mock('@/lib/services/shares', () => ({ resolveShareToken: (t: string) => resolveShareToken(t) }));
vi.mock('@/lib/services/preview', () => ({ previewManager: { getStatus: (id: string) => getStatus(id) } }));

const { GET } = await import('@/app/api/share/[token]/ready/route');
const call = (token = 'tok-1234567890') => GET({} as never, { params: Promise.resolve({ token }) });

describe('GET /api/share/:token/ready', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { resolveShareToken.mockReset(); getStatus.mockReset(); });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('404s for an invalid token without probing', async () => {
    resolveShareToken.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('is not ready while the preview is not running', async () => {
    resolveShareToken.mockResolvedValue('p1');
    getStatus.mockReturnValue({ status: 'starting', port: null });
    const j = await (await call()).json();
    expect(j).toEqual({ success: true, data: { ready: false } });
  });

  it('is not ready when the dev server does not answer', async () => {
    resolveShareToken.mockResolvedValue('p1');
    getStatus.mockReturnValue({ status: 'running', port: 3100 });
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as never;
    expect((await (await call()).json()).data).toEqual({ ready: false });
  });

  it('is ready once the dev server answers (any status), exposing nothing else', async () => {
    resolveShareToken.mockResolvedValue('p1');
    getStatus.mockReturnValue({ status: 'running', port: 3100 });
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as never;
    const j = await (await call()).json();
    expect(j).toEqual({ success: true, data: { ready: true } });
  });
});
