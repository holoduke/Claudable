import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saved: { data: Record<string, unknown> | null } = { data: null };
const existing: { data: Record<string, unknown> | null } = { data: null };
let repoPath = '';
const remote = { status: 200, headSha: '' as string | null };

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/services/project', () => ({ getProjectById: async (id: string) => (id === 'p1' ? { id, repoPath } : null) }));
vi.mock('@/lib/services/project-services', () => ({
  getProjectService: async () => (existing.data ? { serviceData: existing.data } : null),
  upsertProjectServiceConnection: async (_p: string, _k: string, data: Record<string, unknown>) => { saved.data = data; return data; },
}));
vi.mock('@/lib/services/github', async () => {
  const real = await vi.importActual<typeof import('./github')>('./github');
  return {
    ...real,
    ensureProjectRepository: async () => repoPath,
    resolveRepoAuth: async (data: Record<string, unknown>) => ({
      cfg: { provider: 'github', apiBaseUrl: 'https://api.github.com', httpBase: 'https://github.com', org: null, deployDomain: null, authScheme: 'Bearer' },
      token: 'ghs_app', owner: data.owner, repo: data.repo_name, login: 'x-access-token',
      author: { name: 'bot', email: 'bot@x' }, via: 'github-app',
    }),
    githubFetch: async (_t: string, endpoint: string) => {
      if (endpoint === '/repos/new-story/storyloop') {
        if (remote.status !== 200) throw new real.GitHubError('Not Found', remote.status);
        return { name: 'storyloop', owner: { login: 'new-story' }, clone_url: 'https://github.com/new-story/storyloop.git', html_url: 'https://github.com/new-story/storyloop', default_branch: 'main' };
      }
      if (endpoint.startsWith('/repos/new-story/storyloop/branches/')) {
        if (!remote.headSha) throw new real.GitHubError('Branch not found', 404);
        return { commit: { sha: remote.headSha } };
      }
      throw new real.GitHubError('unexpected', 500);
    },
  };
});

const { linkProjectToGithubRepo, parseGithubRepo } = await import('./github-link');

const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();

beforeEach(() => {
  process.env.GIT_PROVIDER = 'gitea';
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'link-'));
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first');
  saved.data = null;
  existing.data = null;
  remote.status = 200;
  remote.headSha = null;
});

afterEach(() => {
  delete process.env.GIT_PROVIDER;
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe('parseGithubRepo', () => {
  it('accepts owner/name and github.com URLs, rejects anything else', () => {
    expect(parseGithubRepo('new-story/storyloop')).toEqual({ owner: 'new-story', repo: 'storyloop' });
    expect(parseGithubRepo('https://github.com/new-story/storyloop.git')).toEqual({ owner: 'new-story', repo: 'storyloop' });
    expect(parseGithubRepo('https://evil.example/new-story/storyloop')).toBeNull();
    expect(parseGithubRepo('new-story/..')).toBeNull();
    expect(parseGithubRepo('a/b/c')).toBeNull();
  });
});

describe('linkProjectToGithubRepo', () => {
  it('stores a github.com override connection and points origin at the repo', async () => {
    const result = await linkProjectToGithubRepo('p1', { owner: 'new-story', repo: 'storyloop', pushMode: 'pr' });
    expect(result).toMatchObject({ owner: 'new-story', repo: 'storyloop', via: 'github-app', warning: null });
    expect(saved.data).toMatchObject({
      provider_override: 'github', owner: 'new-story', repo_name: 'storyloop',
      clone_url: 'https://github.com/new-story/storyloop.git', default_branch: 'main', push_mode: 'pr',
    });
    expect(git('remote', 'get-url', 'origin')).toBe('https://github.com/new-story/storyloop.git');
  });

  it('warns when the remote branch has commits this project does not have', async () => {
    remote.headSha = 'a'.repeat(40);
    const result = await linkProjectToGithubRepo('p1', { owner: 'new-story', repo: 'storyloop' });
    expect(result.warning).toMatch(/already has commits/);
  });

  it('does not warn when the remote is already part of local history', async () => {
    remote.headSha = git('rev-parse', 'HEAD');
    expect((await linkProjectToGithubRepo('p1', { owner: 'new-story', repo: 'storyloop' })).warning).toBeNull();
  });

  it('asks for confirmation before replacing a connection to another repository', async () => {
    existing.data = { clone_url: 'https://git.newstory.tf/newstory/storyloop.git', repo_url: 'https://git.newstory.tf/newstory/storyloop' };
    await expect(linkProjectToGithubRepo('p1', { owner: 'new-story', repo: 'storyloop' })).rejects.toThrow(/already connected/);
    expect(saved.data).toBeNull();
    await linkProjectToGithubRepo('p1', { owner: 'new-story', repo: 'storyloop', force: true });
    expect(saved.data).toMatchObject({ owner: 'new-story', repo_name: 'storyloop' });
  });

  it('re-links the same repository without asking', async () => {
    existing.data = { clone_url: 'https://github.com/new-story/storyloop.git' };
    await linkProjectToGithubRepo('p1', { owner: 'new-story', repo: 'storyloop' });
    expect(saved.data).not.toBeNull();
  });

  it('refuses a repo Claudable cannot see and stores nothing', async () => {
    remote.status = 404;
    await expect(linkProjectToGithubRepo('p1', { owner: 'new-story', repo: 'storyloop' })).rejects.toThrow(/not found, or Claudable has no access/);
    expect(saved.data).toBeNull();
  });
});
