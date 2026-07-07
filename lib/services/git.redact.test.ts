import { describe, it, expect } from 'vitest';
import { redactGitSecrets } from './git';

describe('redactGitSecrets', () => {
  it('masks the token in an authenticated remote URL', () => {
    const url = 'https://newstory:3e08f446a528126604f6554be88dee6911860e7f@git.newstory.tf/newstory-org/farmer-gracy-dashboard.git';
    const out = redactGitSecrets(`Git command failed: git fetch ${url} main`);
    expect(out).not.toContain('3e08f446a528126604f6554be88dee6911860e7f');
    expect(out).toContain('https://newstory:***@git.newstory.tf');
  });

  it('masks tokens embedded in git stderr output', () => {
    const stderr = "fatal: unable to access 'https://user:ghp_secretTOKEN123@github.com/org/repo.git/': 403";
    const out = redactGitSecrets(stderr);
    expect(out).not.toContain('ghp_secretTOKEN123');
    expect(out).toContain('user:***@github.com');
  });

  it('masks every occurrence when the URL appears more than once', () => {
    const url = 'https://u:tok_abc123@host/o/r.git';
    const out = redactGitSecrets(`${url} then again ${url}`);
    expect(out).not.toContain('tok_abc123');
    expect(out.match(/\*\*\*/gu)?.length).toBe(2);
  });

  it('leaves credential-free text untouched', () => {
    const s = 'Git command failed: git merge --ff-only FETCH_HEAD';
    expect(redactGitSecrets(s)).toBe(s);
  });
});
