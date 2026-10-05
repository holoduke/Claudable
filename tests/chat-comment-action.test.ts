import { describe, expect, it } from 'vitest';
import { commentActionError } from '@/components/chat/chat-comment-action';

describe('commentActionError', () => {
  const fallback = 'generic';
  it('treats true, void and { ok: true } as success', () => {
    expect(commentActionError(true, fallback)).toBeNull();
    expect(commentActionError(undefined, fallback)).toBeNull();
    expect(commentActionError({ ok: true }, fallback)).toBeNull();
  });
  it('uses the fallback for false and empty messages', () => {
    expect(commentActionError(false, fallback)).toBe('generic');
    expect(commentActionError('  ', fallback)).toBe('generic');
    expect(commentActionError({ ok: false }, fallback)).toBe('generic');
    expect(commentActionError({ ok: false, message: null }, fallback)).toBe('generic');
  });
  it('passes server messages through', () => {
    expect(commentActionError('Forbidden', fallback)).toBe('Forbidden');
    expect(commentActionError({ ok: false, message: 'Not your comment' }, fallback)).toBe('Not your comment');
  });
});
