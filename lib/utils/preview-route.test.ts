import { describe, expect, it } from 'vitest';
import { normalizePreviewRoute } from './preview-route';

describe('normalizePreviewRoute', () => {
  it('strips the _ts cache-buster and any other query string', () => {
    expect(normalizePreviewRoute('/about?_ts=1727800000000')).toBe('/about');
    expect(normalizePreviewRoute('/search?q=x&_ts=1')).toBe('/search');
    expect(normalizePreviewRoute('/?_ts=1')).toBe('/');
  });
  it('strips the hash', () => {
    expect(normalizePreviewRoute('/docs#intro')).toBe('/docs');
    expect(normalizePreviewRoute('/docs?a=1#intro')).toBe('/docs');
    expect(normalizePreviewRoute('#top')).toBe('/');
  });
  it('ensures a leading slash and drops trailing slashes except for the root', () => {
    expect(normalizePreviewRoute('about')).toBe('/about');
    expect(normalizePreviewRoute('/about/')).toBe('/about');
    expect(normalizePreviewRoute('/a/b//')).toBe('/a/b');
    expect(normalizePreviewRoute('/')).toBe('/');
    expect(normalizePreviewRoute('//')).toBe('/');
    expect(normalizePreviewRoute('')).toBe('/');
    expect(normalizePreviewRoute('  /x  ')).toBe('/x');
  });
  it('collapses repeated slashes', () => {
    expect(normalizePreviewRoute('//a///b')).toBe('/a/b');
  });
  it('reduces an absolute URL to its pathname', () => {
    expect(normalizePreviewRoute('https://p-1.preview.example/about/?_ts=2')).toBe('/about');
  });
  it('falls back to the root for non-strings', () => {
    expect(normalizePreviewRoute(undefined)).toBe('/');
    expect(normalizePreviewRoute(null)).toBe('/');
    expect(normalizePreviewRoute(42)).toBe('/');
  });
});
