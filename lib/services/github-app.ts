/**
 * GitHub App authentication for pushing to github.com repositories.
 *
 * Instead of a long-lived personal token, Claudable can act as a GitHub App:
 * the App's private key signs a short JWT, which buys an installation token
 * for ONE repository at a time (valid ~1 hour). A token minted for project A
 * cannot touch project B's repo, even when the App is installed on both.
 *
 * Configuration (first match wins):
 *   1. Settings → System → GitHub App (stored in the DB, key encrypted at rest)
 *   2. Env: GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (PEM, `\n` escapes allowed)
 *      or GITHUB_APP_PRIVATE_KEY_FILE (path to the PEM file)
 *
 * The private key, JWTs and installation tokens are never logged, never put in
 * an error message and never returned by an API. None of the GITHUB_APP_* env
 * vars is in the agent's env allowlist.
 */

import crypto from 'crypto';
import fs from 'fs';
import { prisma } from '@/lib/db/client';
import { encrypt, decrypt } from '@/lib/crypto';

const GITHUB_API = 'https://api.github.com';
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/u;
const APP_ID_RE = /^\d{1,12}$/u;
/** Re-mint a token this long before GitHub says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const INSTALLATION_CACHE_MS = 10 * 60 * 1000;
const CONFIG_CACHE_MS = 60 * 1000;

export class GitHubAppError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = 'GitHubAppError';
  }
}

/** The App isn't installed on (or can't see) the repository. */
export class GitHubAppNotInstalledError extends GitHubAppError {
  constructor(owner: string, repo: string) {
    super(`The Claudable GitHub App is not installed on ${owner}/${repo}. Install it on that repository first.`, 404);
    this.name = 'GitHubAppNotInstalledError';
  }
}

interface AppCredentials {
  appId: string;
  privateKey: crypto.KeyObject;
  slug: string | null;
  botUserId: string | null;
  source: 'settings' | 'env';
}

export interface GitHubAppStatus {
  configured: boolean;
  source: 'settings' | 'env' | null;
  appId: string | null;
  slug: string | null;
  updatedAt: string | null;
}

export interface GitHubAppIdentity {
  /** Basic-auth user for git over HTTPS with an installation token. */
  login: 'x-access-token';
  name: string;
  email: string;
}

export interface RepoToken {
  token: string;
  expiresAt: number;
}

// ---------------------------------------------------------------- state

interface AppState {
  /** Bumped on every save/delete; work started under an older generation is discarded. */
  generation: number;
  config: { value: AppCredentials | null; at: number } | null;
  identity: Map<string, GitHubAppIdentity>;
  installations: Map<string, { id: number; permissions: Record<string, string>; at: number }>;
  tokens: Map<string, RepoToken>;
  inflight: Map<string, Promise<RepoToken>>;
}

// One state for the whole server process. Route handlers and server code can be
// bundled separately; module-level maps would let a save/delete in one bundle
// leave stale tokens in another.
const globalForApp = globalThis as typeof globalThis & { __claudableGithubApp?: AppState };
const state: AppState = globalForApp.__claudableGithubApp ??= {
  generation: 0,
  config: null,
  identity: new Map(),
  installations: new Map(),
  tokens: new Map(),
  inflight: new Map(),
};

export function invalidateGitHubAppCache(): void {
  state.generation += 1;
  state.config = null;
  state.identity.clear();
  state.installations.clear();
  state.tokens.clear();
  state.inflight.clear();
}

// ---------------------------------------------------------------- credentials

/** Parse a PEM private key; accepts literal `\n` escapes from env files. */
export function parsePrivateKey(pem: string): crypto.KeyObject {
  const text = pem.includes('\\n') && !pem.includes('\n') ? pem.replace(/\\n/gu, '\n') : pem;
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: text.trim(), format: 'pem' });
  } catch {
    throw new GitHubAppError('The private key is not a valid PEM private key.', 400);
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new GitHubAppError('The private key must be the RSA key GitHub generated for the App.', 400);
  }
  return key;
}

function envCredentials(): AppCredentials | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  if (!appId) return null;
  let pem = process.env.GITHUB_APP_PRIVATE_KEY?.trim() || '';
  const file = process.env.GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  if (!pem && file) {
    try {
      pem = fs.readFileSync(file, 'utf8');
    } catch {
      console.warn('[github-app] GITHUB_APP_PRIVATE_KEY_FILE is set but cannot be read');
      return null;
    }
  }
  if (!pem || !APP_ID_RE.test(appId)) return null;
  try {
    return { appId, privateKey: parsePrivateKey(pem), slug: null, botUserId: null, source: 'env' };
  } catch {
    console.warn('[github-app] GITHUB_APP_PRIVATE_KEY is not a valid RSA private key');
    return null;
  }
}

async function loadCredentials(): Promise<AppCredentials | null> {
  if (state.config && Date.now() - state.config.at < CONFIG_CACHE_MS) return state.config.value;
  const generation = state.generation;
  let value: AppCredentials | null = null;
  const row = await prisma.githubApp.findUnique({ where: { id: 'default' } }).catch(() => null);
  if (row) {
    try {
      value = {
        appId: row.appId,
        privateKey: parsePrivateKey(decrypt(row.privateKeyEncrypted)),
        slug: row.slug,
        botUserId: row.botUserId,
        source: 'settings',
      };
    } catch {
      console.warn('[github-app] stored GitHub App key cannot be decrypted; ignoring it');
    }
  }
  value = value ?? envCredentials();
  if (generation === state.generation) state.config = { value, at: Date.now() };
  return value;
}

export async function githubAppConfigured(): Promise<boolean> {
  return (await loadCredentials()) !== null;
}

export async function getGitHubAppStatus(): Promise<GitHubAppStatus> {
  const creds = await loadCredentials();
  const row = creds?.source === 'settings'
    ? await prisma.githubApp.findUnique({ where: { id: 'default' }, select: { updatedAt: true } }).catch(() => null)
    : null;
  return {
    configured: creds !== null,
    source: creds?.source ?? null,
    appId: creds?.appId ?? null,
    slug: creds?.slug ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

// ------------------------------------------------------------------ JWT + API

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** RS256 App JWT, valid ~9 minutes (GitHub's limit is 10), backdated for clock skew. */
export function createAppJwt(appId: string, key: crypto.KeyObject, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}

async function appFetch(path: string, bearer: string | null, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Claudable-Next',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function assertSegments(owner: string, repo: string): void {
  const dotted = (v: string) => v === '.' || v === '..';
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(repo) || dotted(owner) || dotted(repo)) {
    throw new GitHubAppError('Invalid repository name.', 400);
  }
}

// ----------------------------------------------------- installation + tokens

/** What a Claudable token may do; never more than the installation itself grants. */
const WANTED_PERMISSIONS: Record<string, 'read' | 'write'> = {
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
  actions: 'read',
};

export function scopedPermissions(granted: Record<string, string>): Record<string, string> {
  const scoped: Record<string, string> = {};
  for (const [name, wanted] of Object.entries(WANTED_PERMISSIONS)) {
    const has = granted[name];
    if (has === 'write' || has === 'admin') scoped[name] = wanted;
    else if (has === 'read') scoped[name] = 'read';
  }
  return scoped;
}

async function installationFor(creds: AppCredentials, owner: string, repo: string) {
  const key = `${creds.appId}:${owner}/${repo}`.toLowerCase();
  const cached = state.installations.get(key);
  if (cached && Date.now() - cached.at < INSTALLATION_CACHE_MS) return cached;
  const { status, body } = await appFetch(`/repos/${owner}/${repo}/installation`, createAppJwt(creds.appId, creds.privateKey));
  if (status === 404) throw new GitHubAppNotInstalledError(owner, repo);
  if (status === 401) throw new GitHubAppError('GitHub rejected the App credentials (check the App ID and private key).', 401);
  if (status !== 200 || typeof body?.id !== 'number') {
    throw new GitHubAppError(`GitHub App installation lookup failed (HTTP ${status}).`, 502);
  }
  const permissions = body.permissions && typeof body.permissions === 'object' ? body.permissions as Record<string, string> : {};
  const entry = { id: body.id as number, permissions, at: Date.now() };
  state.installations.set(key, entry);
  return entry;
}

async function mintRepoToken(creds: AppCredentials, owner: string, repo: string): Promise<RepoToken> {
  const installation = await installationFor(creds, owner, repo);
  const { status, body } = await appFetch(
    `/app/installations/${installation.id}/access_tokens`,
    createAppJwt(creds.appId, creds.privateKey),
    // One repository, and only the permissions Claudable uses.
    { method: 'POST', body: JSON.stringify({ repositories: [repo], permissions: scopedPermissions(installation.permissions) }) },
  );
  if (status === 404) {
    state.installations.delete(`${creds.appId}:${owner}/${repo}`.toLowerCase());
    throw new GitHubAppNotInstalledError(owner, repo);
  }
  if (status !== 201 || typeof body?.token !== 'string') {
    throw new GitHubAppError(`Could not create a GitHub App token for ${owner}/${repo} (HTTP ${status}).`, 502);
  }
  const expiresAt = Date.parse(String(body.expires_at)) || Date.now() + 60 * 60 * 1000;
  return { token: body.token, expiresAt };
}

/**
 * Installation token for exactly `owner/repo`, cached until shortly before it
 * expires. Concurrent callers share one in-flight request; a token minted while
 * the App was being changed is not kept.
 */
export async function getRepoInstallationToken(owner: string, repo: string): Promise<RepoToken> {
  assertSegments(owner, repo);
  const creds = await loadCredentials();
  if (!creds) throw new GitHubAppError('No GitHub App is configured.', 400);
  const key = `${creds.appId}:${owner}/${repo}`.toLowerCase();
  const cached = state.tokens.get(key);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return cached;
  const pending = state.inflight.get(key);
  if (pending) return pending;
  const generation = state.generation;
  const request = mintRepoToken(creds, owner, repo)
    .then((minted) => {
      if (generation === state.generation) state.tokens.set(key, minted);
      return minted;
    })
    .finally(() => {
      if (state.inflight.get(key) === request) state.inflight.delete(key);
    });
  state.inflight.set(key, request);
  return request;
}

/** Commit author for App pushes: the App's bot user, so GitHub links the commits to it. */
export async function getGitHubAppIdentity(): Promise<GitHubAppIdentity> {
  const creds = await loadCredentials();
  if (!creds) throw new GitHubAppError('No GitHub App is configured.', 400);
  const cached = state.identity.get(creds.appId);
  if (cached) return cached;
  let { slug, botUserId } = creds;
  if (!slug || !botUserId) {
    try {
      ({ slug, botUserId } = await resolveAppIdentity(creds.appId, creds.privateKey));
    } catch (error) {
      // Who the commits are attributed to must never block a publish.
      console.warn('[github-app] could not resolve the App bot user:', error instanceof Error ? error.message : error);
      return { login: 'x-access-token', name: 'Claudable', email: 'claudable@users.noreply.github.com' };
    }
  }
  const identity: GitHubAppIdentity = {
    login: 'x-access-token',
    name: `${slug}[bot]`,
    email: `${botUserId}+${slug}[bot]@users.noreply.github.com`,
  };
  state.identity.set(creds.appId, identity);
  return identity;
}

/** Ask GitHub who the App is (slug) and which bot user commits as it. */
async function resolveAppIdentity(appId: string, key: crypto.KeyObject): Promise<{ slug: string; botUserId: string }> {
  const app = await appFetch('/app', createAppJwt(appId, key));
  // GitHub answers an unknown App ID with 404 and a key that doesn't match with 401.
  if (app.status === 401 || app.status === 404) throw new GitHubAppError('GitHub rejected the App credentials (check the App ID and private key).', 401);
  if (app.status !== 200 || typeof app.body?.slug !== 'string') {
    throw new GitHubAppError(`Could not read the GitHub App (HTTP ${app.status}).`, 502);
  }
  if (String(app.body.id) !== appId) {
    throw new GitHubAppError('The private key belongs to a different GitHub App than this App ID.', 400);
  }
  const slug = app.body.slug as string;
  const bot = await appFetch(`/users/${encodeURIComponent(`${slug}[bot]`)}`, null);
  const botUserId = typeof bot.body?.id === 'number' ? String(bot.body.id) : null;
  if (!botUserId) throw new GitHubAppError(`Could not find the bot user of App "${slug}".`, 502);
  return { slug, botUserId };
}

// ------------------------------------------------------------- admin storage

/**
 * Validate the credentials against GitHub, then store them (key encrypted).
 * Nothing is saved when GitHub doesn't accept them.
 */
export async function saveGitHubApp(appIdInput: string, privateKeyPem: string, updatedBy: string | null): Promise<GitHubAppStatus> {
  const appId = String(appIdInput ?? '').trim();
  if (!APP_ID_RE.test(appId)) throw new GitHubAppError('The App ID must be a number.', 400);
  if (!privateKeyPem || privateKeyPem.length > 10_000) throw new GitHubAppError('Paste the App private key (.pem).', 400);
  const key = parsePrivateKey(privateKeyPem);
  const { slug, botUserId } = await resolveAppIdentity(appId, key);
  const pem = key.export({ type: 'pkcs8', format: 'pem' }).toString();
  const data = { appId, slug, botUserId, privateKeyEncrypted: encrypt(pem), updatedBy };
  await prisma.githubApp.upsert({ where: { id: 'default' }, create: { id: 'default', ...data }, update: data });
  invalidateGitHubAppCache();
  return getGitHubAppStatus();
}

export async function deleteGitHubApp(): Promise<GitHubAppStatus> {
  await prisma.githubApp.deleteMany({ where: { id: 'default' } });
  invalidateGitHubAppCache();
  return getGitHubAppStatus();
}
