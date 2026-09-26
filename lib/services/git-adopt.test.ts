import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
const { parseOwnRemote } = await import('./git-adopt');

describe('parseOwnRemote', () => {
  const base = 'https://git.example.org';
  it('accepts owner/repo on the own host, with or without .git and credentials', () => {
    expect(parseOwnRemote('https://git.example.org/team/site.git', base)).toEqual({ owner: 'team', repo: 'site' });
    expect(parseOwnRemote('https://u:secret@git.example.org/team/site', base)).toEqual({ owner: 'team', repo: 'site' });
  });
  it('rejects other hosts, protocols and odd paths', () => {
    for (const url of [
      'https://github.com/team/site.git',
      'http://git.example.org/team/site.git',
      'git@git.example.org:team/site.git',
      'https://git.example.org/team/sub/site.git',
      'https://git.example.org/site.git',
      'https://git.example.org.evil.com/team/site.git',
      'https://git.example.org/team/%2e%2e',
    ]) expect(parseOwnRemote(url, base), url).toBeNull();
  });
  it('honours a base path', () => {
    expect(parseOwnRemote('https://h.org/git/team/site.git', 'https://h.org/git')).toEqual({ owner: 'team', repo: 'site' });
    expect(parseOwnRemote('https://h.org/other/team/site.git', 'https://h.org/git')).toBeNull();
  });
});
