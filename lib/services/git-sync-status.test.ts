import { describe, expect, it } from 'vitest';
import { remoteHeadSha, parseCompareCount } from './git-sync-status';

describe('remoteHeadSha', () => {
  it('reads a GitHub branch response (commit.sha)', () => {
    expect(remoteHeadSha({ commit: { sha: 'abc123' } })).toBe('abc123');
  });

  it('reads a Gitea branch response (commit.id)', () => {
    expect(remoteHeadSha({ commit: { id: 'def456' } })).toBe('def456');
  });

  it('prefers sha when both are present', () => {
    expect(remoteHeadSha({ commit: { sha: 'abc', id: 'def' } })).toBe('abc');
  });

  it('returns null for malformed responses', () => {
    expect(remoteHeadSha(null)).toBeNull();
    expect(remoteHeadSha({})).toBeNull();
    expect(remoteHeadSha({ commit: {} })).toBeNull();
    expect(remoteHeadSha({ commit: { sha: 42 } })).toBeNull();
  });
});

describe('parseCompareCount', () => {
  it('reads a GitHub compare response (ahead_by)', () => {
    expect(parseCompareCount({ ahead_by: 7, commits: [{}, {}] })).toBe(7);
  });

  it('reads a Gitea compare response (total_commits)', () => {
    expect(parseCompareCount({ total_commits: 3 })).toBe(3);
  });

  it('falls back to counting commits[]', () => {
    expect(parseCompareCount({ commits: [{}, {}, {}] })).toBe(3);
  });

  it('returns null when no usable count is present', () => {
    expect(parseCompareCount(null)).toBeNull();
    expect(parseCompareCount({})).toBeNull();
    expect(parseCompareCount({ ahead_by: 'many' })).toBeNull();
  });
});
