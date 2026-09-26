import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
const { mergeRequestInit } = await import('./github');

describe('mergeRequestInit', () => {
  it('uses Gitea\'s POST {Do} form — the GitHub PUT form is a 405 there', () => {
    const init = mergeRequestInit({ provider: 'gitea' }, 'Merge x into main');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ Do: 'merge', merge_title_field: 'Merge x into main' });
  });
  it('keeps GitHub\'s PUT {merge_method}', () => {
    const init = mergeRequestInit({ provider: 'github' }, 't');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ merge_method: 'merge' });
  });
});
