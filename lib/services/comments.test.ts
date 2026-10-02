import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
const create = vi.fn();
vi.mock('@/lib/db/client', () => ({
  prisma: {
    comment: { findMany: (...a: unknown[]) => findMany(...a), create: (...a: unknown[]) => create(...a) },
    project: { findUnique: vi.fn(async () => null) },
    user: { findMany: vi.fn(async () => []) },
  },
}));

const { listComments, createComment } = await import('./comments');

const row = (route: string) => ({
  id: 'c1', projectId: 'p', route, anchorSelector: 'body', relX: 0.5, relY: 0.5, body: 'hi',
  resolved: false, authorId: null, authorName: 'A', mentionsJson: null, author: null,
  createdAt: new Date(0), updatedAt: new Date(0),
});

describe('comments route normalisation', () => {
  beforeEach(() => { findMany.mockReset(); create.mockReset(); });

  it('stores a cache-busted route as its pathname', async () => {
    create.mockImplementation(async ({ data }: { data: { route: string } }) => row(data.route));
    const c = await createComment({ projectId: 'p', route: '/about/?_ts=123#x', anchorSelector: 'body', relX: 0.5, relY: 0.5, body: 'hi' });
    expect(create.mock.calls[0][0].data.route).toBe('/about');
    expect(c.route).toBe('/about');
  });

  it('lists by the normalised route and also matches legacy polluted rows', async () => {
    findMany.mockResolvedValue([row('/about?_ts=1')]);
    const list = await listComments('p', '/about?_ts=999');
    expect(findMany.mock.calls[0][0].where).toEqual({
      projectId: 'p',
      OR: [{ route: '/about' }, { route: { startsWith: '/about?' } }, { route: { startsWith: '/about#' } }],
    });
    expect(list[0].route).toBe('/about');
  });

  it('lists every route when none is given', async () => {
    findMany.mockResolvedValue([]);
    await listComments('p');
    expect(findMany.mock.calls[0][0].where).toEqual({ projectId: 'p' });
  });
});
