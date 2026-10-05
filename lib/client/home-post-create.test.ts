import { describe, it, expect, vi } from 'vitest';
import { buildPostCreateNotice, storePostCreateNotice, postCreateNoticeKey, postCreatePromptKey } from './home-post-create';

const dict: Record<string, string> = {
  'home.notice.actFailed': 'Could not start — your prompt: {prompt}',
  'home.notice.actFailedNoPrompt': 'Could not start.',
  'home.notice.uploadFailed': 'Uploads failed: {names}',
  'home.notice.warnings': 'Created with notes: {details}',
  'home.warning.backend_scaffold_failed': 'backend missing',
};
const t = (key: string, vars?: Record<string, string | number>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ''));
const ok = { failedUploads: [], actFailed: false, prompt: 'build a blog', warningCodes: [], warnings: [] };

describe('buildPostCreateNotice', () => {
  it('returns null when everything succeeded', () => {
    expect(buildPostCreateNotice(ok, t)).toBeNull();
  });

  it('keeps the prompt in the message when the assistant could not start', () => {
    expect(buildPostCreateNotice({ ...ok, actFailed: true }, t)).toEqual({ type: 'error', message: 'Could not start — your prompt: build a blog' });
    expect(buildPostCreateNotice({ ...ok, actFailed: true, prompt: '  ' }, t)?.message).toBe('Could not start.');
  });

  it('lists failed uploads as an error', () => {
    expect(buildPostCreateNotice({ ...ok, failedUploads: ['a.zip', 'b.pdf'] }, t)).toEqual({ type: 'error', message: 'Uploads failed: “a.zip”, “b.pdf”' });
  });

  it('turns server warnings into an info notice, translating known codes and falling back to the message', () => {
    const n = buildPostCreateNotice({ ...ok, warningCodes: ['backend_scaffold_failed', 'new_code'], warnings: ['Backend failed', 'Something else'] }, t);
    expect(n).toEqual({ type: 'info', message: 'Created with notes: backend missing; Something else' });
  });

  it('errors win over warnings but keep them in the message', () => {
    const n = buildPostCreateNotice({ ...ok, actFailed: true, warningCodes: ['backend_scaffold_failed'], warnings: ['x'] }, t);
    expect(n?.type).toBe('error');
    expect(n?.message).toContain('backend missing');
  });
});

describe('storePostCreateNotice', () => {
  it('stores the notice and the unsent prompt under the contract keys', () => {
    const setItem = vi.fn();
    storePostCreateNotice({ setItem }, 'p1', { type: 'error', message: 'm' }, 'my prompt');
    expect(setItem).toHaveBeenCalledWith(postCreateNoticeKey('p1'), JSON.stringify({ type: 'error', message: 'm' }));
    expect(setItem).toHaveBeenCalledWith(postCreatePromptKey('p1'), 'my prompt');
    expect(postCreateNoticeKey('p1')).toBe('claudable:postCreateNotice:p1');
  });

  it('swallows storage errors', () => {
    const setItem = vi.fn(() => { throw new Error('quota'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => storePostCreateNotice({ setItem }, 'p1', { type: 'info', message: 'm' })).not.toThrow();
    warn.mockRestore();
  });
});
