import { describe, it, expect } from 'vitest';
import { shouldKeep, commonRootPrefix, screenName } from '@/lib/utils/design-keep';

describe('shouldKeep', () => {
  it('keeps .dc.html screens at any depth', () => {
    expect(shouldKeep('Home.dc.html')).toBe(true);
    expect(shouldKeep('Design System.dc.html')).toBe(true);
    expect(shouldKeep('Wrapper/Home.dc.html')).toBe(true);
  });

  it('keeps fonts/ and assets/ at the root', () => {
    expect(shouldKeep('fonts/x.woff2')).toBe(true);
    expect(shouldKeep('assets/hero.png')).toBe(true);
    expect(shouldKeep('assets/icons/a.svg')).toBe(true);
  });

  it('keeps fonts/ and assets/ nested under a wrapper directory', () => {
    expect(shouldKeep('MyDesign/fonts/x.woff2')).toBe(true);
    expect(shouldKeep('MyDesign/assets/hero.png')).toBe(true);
  });

  it('drops design-process noise', () => {
    expect(shouldKeep('screenshots/shot.png')).toBe(false);
    expect(shouldKeep('uploads/junk.pdf')).toBe(false);
    expect(shouldKeep('support.js')).toBe(false);
    expect(shouldKeep('.thumbnail')).toBe(false);
  });

  it('rejects directory entries, empties, and path traversal', () => {
    expect(shouldKeep('assets/')).toBe(false);
    expect(shouldKeep('')).toBe(false);
    expect(shouldKeep('../secret/assets/x.png')).toBe(false);
  });
});

describe('commonRootPrefix', () => {
  it('returns "" for a flat export (files already at root)', () => {
    expect(commonRootPrefix(['Home.dc.html', 'assets/x.png', 'fonts/y.woff'])).toBe('');
  });

  it('detects and returns a single wrapper directory', () => {
    expect(
      commonRootPrefix(['MyDesign/Home.dc.html', 'MyDesign/assets/x.png', 'MyDesign/fonts/y.woff']),
    ).toBe('MyDesign/');
  });

  it('does not treat a meaningful top-level dir (assets/fonts) as a wrapper', () => {
    expect(commonRootPrefix(['assets/a.png', 'assets/b.png'])).toBe('');
    expect(commonRootPrefix(['fonts/a.woff', 'fonts/b.woff'])).toBe('');
  });

  it('returns "" for an empty list', () => {
    expect(commonRootPrefix([])).toBe('');
  });

  it('returns "" when entries have differing roots', () => {
    expect(commonRootPrefix(['A/x.dc.html', 'B/y.dc.html'])).toBe('');
  });
});

describe('screenName', () => {
  it('strips the .dc.html suffix and any directory', () => {
    expect(screenName('Home.dc.html')).toBe('Home');
    expect(screenName('Wrapper/Design System.dc.html')).toBe('Design System');
  });
});
