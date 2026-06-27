import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { toRelativePath, getFileName, getDirectoryPath } from '@/lib/utils/path';

describe('getFileName', () => {
  it('returns the last segment', () => {
    expect(getFileName('src/app/page.tsx')).toBe('page.tsx');
  });
  it('handles windows separators', () => {
    expect(getFileName('src\\app\\page.tsx')).toBe('page.tsx');
  });
  it('returns the input for a bare filename', () => {
    expect(getFileName('page.tsx')).toBe('page.tsx');
  });
  it('passes through empty/undefined', () => {
    expect(getFileName('')).toBe('');
    // @ts-expect-error exercising the nullish guard
    expect(getFileName(undefined)).toBeUndefined();
  });
});

describe('getDirectoryPath', () => {
  it('strips the filename', () => {
    expect(getDirectoryPath('src/app/page.tsx')).toBe('src/app');
  });
  it('handles windows separators', () => {
    expect(getDirectoryPath('src\\app\\page.tsx')).toBe('src/app');
  });
  it('returns "/" for a top-level file', () => {
    expect(getDirectoryPath('file.txt')).toBe('/');
  });
});

describe('toRelativePath', () => {
  const ORIG = process.env.NEXT_PUBLIC_PROJECT_ROOT;
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_PROJECT_ROOT;
  });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.NEXT_PUBLIC_PROJECT_ROOT;
    else process.env.NEXT_PUBLIC_PROJECT_ROOT = ORIG;
  });

  it('passes through empty input', () => {
    expect(toRelativePath('')).toBe('');
  });

  it('treats text-with-whitespace as plain text (not a path)', () => {
    expect(toRelativePath('this is a sentence')).toBe('this is a sentence');
  });

  it('extracts the path after a user project directory (relative form)', () => {
    expect(toRelativePath('data/projects/project-abc123/src/app/page.tsx')).toBe('/src/app/page.tsx');
  });

  it('adds a leading slash to other relative paths', () => {
    expect(toRelativePath('foo/bar.ts')).toBe('/foo/bar.ts');
  });

  it('strips the configured project root from an absolute path', () => {
    process.env.NEXT_PUBLIC_PROJECT_ROOT = '/srv/app';
    expect(toRelativePath('/srv/app/src/index.ts')).toBe('/src/index.ts');
  });

  it('falls back to the basename when nothing else matches', () => {
    expect(toRelativePath('/Users/jjh/package.json')).toBe('/package.json');
  });
});
