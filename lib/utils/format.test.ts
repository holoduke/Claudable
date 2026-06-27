import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatTimeAgo, getFileLanguage, escapeHtml } from '@/lib/utils/format';

describe('formatTimeAgo', () => {
  afterEach(() => vi.useRealTimers());

  it('returns null for empty/invalid input', () => {
    expect(formatTimeAgo()).toBeNull();
    expect(formatTimeAgo('')).toBeNull();
    expect(formatTimeAgo('not-a-date')).toBeNull();
  });

  it('formats relative times against a fixed now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(formatTimeAgo(ago(10_000))).toBe('just now');
    expect(formatTimeAgo(ago(60_000))).toBe('1 minute ago');
    expect(formatTimeAgo(ago(5 * 60_000))).toBe('5 minutes ago');
    expect(formatTimeAgo(ago(60 * 60_000))).toBe('1 hour ago');
    expect(formatTimeAgo(ago(3 * 60 * 60_000))).toBe('3 hours ago');
    expect(formatTimeAgo(ago(24 * 60 * 60_000))).toBe('1 day ago');
    expect(formatTimeAgo(ago(3 * 24 * 60 * 60_000))).toBe('3 days ago');
  });
});

describe('getFileLanguage', () => {
  it('maps common extensions', () => {
    expect(getFileLanguage('app/page.tsx')).toBe('typescript');
    expect(getFileLanguage('x.mjs')).toBe('javascript');
    expect(getFileLanguage('styles.scss')).toBe('scss');
    expect(getFileLanguage('a.vue')).toBe('vue');
    expect(getFileLanguage('nuxt.config.ts')).toBe('typescript');
  });
  it('falls back to plaintext for unknown/extensionless', () => {
    expect(getFileLanguage('LICENSE')).toBe('plaintext');
    expect(getFileLanguage('weird.xyz')).toBe('plaintext');
  });
});

describe('escapeHtml', () => {
  it('escapes all five HTML-sensitive characters', () => {
    expect(escapeHtml(`<a href="x" data-y='z'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; data-y=&#39;z&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
  it('leaves plain text untouched', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});
