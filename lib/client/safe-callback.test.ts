import { describe, expect, it } from 'vitest';
import { safeCallbackPath } from './safe-callback';

describe('safeCallbackPath', () => {
  it('keeps same-site paths with query', () => {
    expect(safeCallbackPath('/kennisbank/chat')).toBe('/kennisbank/chat');
    expect(safeCallbackPath('%2Fp1%2Fchat%3Fx%3D1')).toBe('/p1/chat?x=1');
  });
  it('refuses other sites, schemes, control chars and loops back to /login', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', '%2F%2Fevil.example', 'javascript:alert(1)', '/a\nb', '/login', '/login?callbackUrl=/x', '%E0%A4%A']) {
      expect(safeCallbackPath(bad)).toBe('/');
    }
    expect(safeCallbackPath(undefined)).toBe('/');
  });
});
