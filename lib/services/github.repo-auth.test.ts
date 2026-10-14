import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/services/tokens', () => ({ getPlainServiceToken: async () => null }));

const app = {
  configured: true,
  installed: true,
  broken: false,
  getRepoInstallationToken: vi.fn(async (_o: string, _r: string) => ({ token: 'ghs_app', expiresAt: Date.now() + 3_600_000 })),
};
vi.mock('@/lib/services/github-app', async () => {
  const real = await vi.importActual<typeof import('./github-app')>('./github-app');
  return {
    ...real,
    githubAppConfigured: async () => app.configured,
    getRepoInstallationToken: async (owner: string, repo: string) => {
      if (!app.installed) throw new real.GitHubAppNotInstalledError(owner, repo);
      if (app.broken) throw new real.GitHubAppError('GitHub rejected the App credentials (check the App ID and private key).', 401);
      return app.getRepoInstallationToken(owner, repo);
    },
    getGitHubAppIdentity: async () => ({ login: 'x-access-token', name: 'claudable[bot]', email: '1+claudable[bot]@users.noreply.github.com' }),
  };
});

const { resolveRepoAuth, authenticatedCloneUrl, GitHubError } = await import('./github');

const githubRepo = { provider_override: 'github', owner: 'new-story', repo_name: 'storyloop' };
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ login: 'holoduke', name: 'Gillis', email: null }), {
  status: 200, headers: { 'content-type': 'application/json' },
}));

beforeEach(() => {
  process.env.GIT_PROVIDER = 'gitea';
  process.env.GIT_TOKEN = 'gitea_token';
  delete process.env.GITHUB_TOKEN;
  app.configured = true;
  app.installed = true;
  app.broken = false;
  app.getRepoInstallationToken.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  delete process.env.GIT_PROVIDER;
  delete process.env.GIT_TOKEN;
  delete process.env.GITHUB_TOKEN;
  vi.unstubAllGlobals();
});

describe('resolveRepoAuth', () => {
  it('uses the GitHub App for a github.com repo it is installed on', async () => {
    const auth = await resolveRepoAuth(githubRepo);
    expect(auth).toMatchObject({ via: 'github-app', token: 'ghs_app', login: 'x-access-token', owner: 'new-story', repo: 'storyloop' });
    expect(auth.author.name).toBe('claudable[bot]');
    expect(app.getRepoInstallationToken).toHaveBeenCalledWith('new-story', 'storyloop');
    expect(fetchMock).not.toHaveBeenCalled(); // no /user call with an installation token
  });

  it('falls back to GITHUB_TOKEN when the App is not installed on the repo', async () => {
    app.installed = false;
    process.env.GITHUB_TOKEN = 'ghp_fallback';
    const auth = await resolveRepoAuth(githubRepo);
    expect(auth).toMatchObject({ via: 'token', token: 'ghp_fallback', login: 'holoduke' });
  });

  it('keeps publishing on the token when the App key is rejected', async () => {
    app.broken = true;
    process.env.GITHUB_TOKEN = 'ghp_fallback';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await resolveRepoAuth(githubRepo)).toMatchObject({ via: 'token', token: 'ghp_fallback' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('explains a missing installation when there is no token to fall back to', async () => {
    app.installed = false;
    const error = await resolveRepoAuth(githubRepo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as Error).message).toMatch(/not installed on new-story\/storyloop/);
  });

  it('keeps the instance git server (Gitea) on its own token, App or not', async () => {
    const auth = await resolveRepoAuth({ owner: 'newstory-org', repo_name: 'klantportaal' });
    expect(auth).toMatchObject({ via: 'token', token: 'gitea_token' });
    expect(app.getRepoInstallationToken).not.toHaveBeenCalled();
  });

  it('uses the token flow when no App is configured', async () => {
    app.configured = false;
    process.env.GITHUB_TOKEN = 'ghp_classic';
    expect(await resolveRepoAuth(githubRepo)).toMatchObject({ via: 'token', token: 'ghp_classic' });
  });
});

describe('authenticatedCloneUrl', () => {
  const appAuth = { login: 'x-access-token', token: 'ghs_x', via: 'github-app' as const, owner: 'new-story', repo: 'storyloop' };

  it('embeds the basic-auth user and token for one git command', () => {
    expect(authenticatedCloneUrl('https://github.com/new-story/storyloop.git', appAuth))
      .toBe('https://x-access-token:ghs_x@github.com/new-story/storyloop.git');
  });

  it('refuses to send an App token anywhere but its own repository', () => {
    expect(() => authenticatedCloneUrl('https://github.com/new-story/other.git', appAuth)).toThrow(/does not match/);
    expect(() => authenticatedCloneUrl('https://evil.example/new-story/storyloop.git', appAuth)).toThrow(/does not match/);
    expect(() => authenticatedCloneUrl('https://x@github.com/new-story/storyloop.git', appAuth)).toThrow(/does not match/);
  });

  it('leaves the Gitea token flow as it was', () => {
    expect(authenticatedCloneUrl('https://git.newstory.tf/org/app.git', { login: 'newstory', token: 't', via: 'token', owner: 'org', repo: 'app' }))
      .toBe('https://newstory:t@git.newstory.tf/org/app.git');
  });
});
