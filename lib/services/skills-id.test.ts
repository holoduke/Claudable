import { describe, it, expect } from 'vitest';
import { normalizeSkillName, assertSafeSkillId, SkillError } from '@/lib/services/skills-id';

describe('normalizeSkillName', () => {
  it('kebab-cases names', () => {
    expect(normalizeSkillName('Brand Voice')).toBe('brand-voice');
    expect(normalizeSkillName('My_Cool Skill!!')).toBe('my-cool-skill');
  });
  it('strips path-traversal characters down to a safe slug', () => {
    expect(normalizeSkillName('../../etc/passwd')).toBe('etc-passwd');
  });
  it('throws on names that reduce to empty', () => {
    expect(() => normalizeSkillName('!!!')).toThrow(SkillError);
    expect(() => normalizeSkillName('   ')).toThrow(SkillError);
  });
});

describe('assertSafeSkillId', () => {
  it('accepts a clean single path segment', () => {
    expect(assertSafeSkillId('seo-audit')).toBe('seo-audit');
    expect(assertSafeSkillId('  nuxt-ui  ')).toBe('nuxt-ui');
  });
  it('rejects path traversal, separators, dotfiles, and empties', () => {
    for (const bad of ['', '   ', '../secret', 'a/b', 'a\\b', '..', '.hidden', './x']) {
      expect(() => assertSafeSkillId(bad)).toThrow(SkillError);
    }
  });
});
