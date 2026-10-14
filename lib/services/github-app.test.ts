import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store: { row: any } = { row: null };
vi.mock('@/lib/db/client', () => ({
  prisma: {
    githubApp: {
      findUnique: vi.fn(async () => store.row),
      upsert: vi.fn(async ({ create }: any) => { store.row = { ...create, updatedAt: new Date() }; return store.row; }),
      deleteMany: vi.fn(async () => { store.row = null; return { count: 1 }; }),
    },
  },
}));

import {
  GitHubAppNotInstalledError, createAppJwt, deleteGitHubApp, getGitHubAppIdentity, getRepoInstallationToken, githubAppConfigured,
  invalidateGitHubAppCache, parsePrivateKey, saveGitHubApp, scopedPermissions,
} from './github-app';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

type Handler = (url: string, init: RequestInit) => { status: number; body: unknown };
let handler: Handler;
const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
  const { status, body } = handler(url, init);
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
});

function decodeJwt(jwt: string) {
  const [h, p, s] = jwt.split('.');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'));
  return { ok, payload: JSON.parse(Buffer.from(p, 'base64url').toString()) };
}

const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function githubApi(overrides: Partial<Record<string, { status: number; body: unknown }>> = {}): Handler {
  return (url, init) => {
    const path = url.replace('https://api.github.com', '');
    const key = `${init.method ?? 'GET'} ${path}`;
    if (overrides[key]) return overrides[key]!;
    if (key === 'GET /repos/new-story/storyloop/installation') {
      return { status: 200, body: { id: 77, permissions: { contents: 'write', pull_requests: 'write', metadata: 'read', administration: 'write' } } };
    }
    if (key === 'POST /app/installations/77/access_tokens') return { status: 201, body: { token: 'ghs_repo_token', expires_at: inAnHour() } };
    if (key === 'GET /app') return { status: 200, body: { id: 123, slug: 'claudable-newstory' } };
    if (key === 'GET /users/claudable-newstory%5Bbot%5D') return { status: 200, body: { id: 9001 } };
    return { status: 404, body: { message: 'Not Found' } };
  };
}

beforeEach(() => {
  store.row = null;
  invalidateGitHubAppCache();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  handler = githubApi();
  process.env.GITHUB_APP_ID = '123';
  process.env.GITHUB_APP_PRIVATE_KEY = PEM.replace(/\n/gu, '\\n'); // as written in an .env file
});

afterEach(() => {
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  vi.unstubAllGlobals();
});

describe('createAppJwt / parsePrivateKey', () => {
  it('signs an RS256 JWT for the App that GitHub accepts (iss, <10 min)', () => {
    const { ok, payload } = decodeJwt(createAppJwt('123', parsePrivateKey(PEM), 1_000_000_000));
    expect(ok).toBe(true);
    expect(payload.iss).toBe('123');
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
  });

  it('accepts \\n-escaped PEM and rejects non-RSA or invalid keys', () => {
    expect(parsePrivateKey(PEM.replace(/\n/gu, '\\n')).asymmetricKeyType).toBe('rsa');
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => parsePrivateKey(ec)).toThrow(/RSA/);
    expect(() => parsePrivateKey('not a key')).toThrow(/PEM/);
  });
});

describe('getRepoInstallationToken', () => {
  it('mints a token for exactly the one repository, with only the permissions Claudable uses', async () => {
    const { token } = await getRepoInstallationToken('new-story', 'storyloop');
    expect(token).toBe('ghs_repo_token');
    const mint = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/access_tokens'))!;
    expect(JSON.parse(String(mint[1]?.body))).toEqual({
      repositories: ['storyloop'],
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    });
    const auth = String((mint[1]?.headers as Record<string, string>).Authorization);
    expect(decodeJwt(auth.replace('Bearer ', '')).ok).toBe(true);
  });

  it('caches the token and shares one request between concurrent callers', async () => {
    await Promise.all([getRepoInstallationToken('new-story', 'storyloop'), getRepoInstallationToken('new-story', 'storyloop')]);
    await getRepoInstallationToken('new-story', 'storyloop');
    expect(fetchMock).toHaveBeenCalledTimes(2); // one installation lookup + one mint
  });

  it('mints a new token when the cached one is about to expire', async () => {
    handler = githubApi({ 'POST /app/installations/77/access_tokens': { status: 201, body: { token: 'ghs_short', expires_at: new Date(Date.now() + 60_000).toISOString() } } });
    await getRepoInstallationToken('new-story', 'storyloop');
    await getRepoInstallationToken('new-story', 'storyloop');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/access_tokens'))).toHaveLength(2);
  });

  it('reports a repository the App is not installed on', async () => {
    await expect(getRepoInstallationToken('new-story', 'other')).rejects.toBeInstanceOf(GitHubAppNotInstalledError);
  });

  it('rejects unsafe repository names before calling GitHub', async () => {
    await expect(getRepoInstallationToken('new-story', '../x')).rejects.toThrow(/Invalid repository/);
    await expect(getRepoInstallationToken('..', 'app')).rejects.toThrow(/Invalid repository/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never puts the key or a token in an error message', async () => {
    handler = githubApi({ 'POST /app/installations/77/access_tokens': { status: 500, body: { message: 'boom' } } });
    const error = await getRepoInstallationToken('new-story', 'storyloop').catch((e: Error) => e);
    expect(String((error as Error).message)).not.toMatch(/PRIVATE KEY|ghs_|eyJ/);
  });

  it('is unavailable without configuration', async () => {
    delete process.env.GITHUB_APP_ID;
    invalidateGitHubAppCache();
    expect(await githubAppConfigured()).toBe(false);
    await expect(getRepoInstallationToken('new-story', 'storyloop')).rejects.toThrow(/No GitHub App/);
  });
});

describe('scopedPermissions', () => {
  it('never asks for more than the installation grants', () => {
    expect(scopedPermissions({ contents: 'read', actions: 'read', administration: 'write' })).toEqual({ contents: 'read', actions: 'read' });
    expect(scopedPermissions({ contents: 'write', pull_requests: 'write', metadata: 'read', actions: 'write' }))
      .toEqual({ contents: 'write', pull_requests: 'write', metadata: 'read', actions: 'read' });
  });
});

describe('cache invalidation', () => {
  it('drops cached tokens when the App is removed', async () => {
    await saveGitHubApp('123', PEM, null);
    await getRepoInstallationToken('new-story', 'storyloop');
    delete process.env.GITHUB_APP_ID;
    await deleteGitHubApp();
    await expect(getRepoInstallationToken('new-story', 'storyloop')).rejects.toThrow(/No GitHub App/);
  });

  it('does not keep a token minted while the App was being changed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const base = githubApi();
    handler = (url, init) => base(url, init);
    fetchMock.mockImplementationOnce(async (url: string, init: RequestInit = {}) => {
      await gate;
      const { status, body } = base(url, init);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    });
    const pending = getRepoInstallationToken('new-story', 'storyloop');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled()); // the mint is under way
    invalidateGitHubAppCache();
    release();
    await pending;
    fetchMock.mockClear();
    await getRepoInstallationToken('new-story', 'storyloop');
    expect(fetchMock).toHaveBeenCalled(); // re-minted, the stale result was not cached
  });
});

describe('identity and admin storage', () => {
  it('falls back to a generic author when GitHub cannot tell who the bot is', async () => {
    handler = githubApi({ 'GET /app': { status: 500, body: {} } });
    expect(await getGitHubAppIdentity()).toMatchObject({ login: 'x-access-token', name: 'Claudable' });
  });

  it('commits as the App bot user', async () => {
    expect(await getGitHubAppIdentity()).toEqual({
      login: 'x-access-token',
      name: 'claudable-newstory[bot]',
      email: '9001+claudable-newstory[bot]@users.noreply.github.com',
    });
  });

  it('stores a validated key encrypted and prefers it over env config', async () => {
    delete process.env.GITHUB_APP_ID;
    const status = await saveGitHubApp('123', PEM, 'admin@newstory.nl');
    expect(status).toMatchObject({ configured: true, source: 'settings', appId: '123', slug: 'claudable-newstory' });
    expect(store.row.privateKeyEncrypted).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(status)).not.toContain('PRIVATE KEY');
    expect((await getRepoInstallationToken('new-story', 'storyloop')).token).toBe('ghs_repo_token');
  });

  it('refuses a key that belongs to another App and saves nothing', async () => {
    handler = githubApi({ 'GET /app': { status: 200, body: { id: 999, slug: 'someone-else' } } });
    await expect(saveGitHubApp('123', PEM, null)).rejects.toThrow(/different GitHub App/);
    expect(store.row).toBeNull();
  });

  it('refuses credentials GitHub rejects', async () => {
    handler = githubApi({ 'GET /app': { status: 401, body: { message: 'bad credentials' } } });
    await expect(saveGitHubApp('123', PEM, null)).rejects.toThrow(/rejected/);
    handler = githubApi({ 'GET /app': { status: 404, body: { message: 'Integration not found' } } });
    await expect(saveGitHubApp('123', PEM, null)).rejects.toThrow(/rejected/);
    await expect(saveGitHubApp('abc', PEM, null)).rejects.toThrow(/must be a number/);
  });
});
