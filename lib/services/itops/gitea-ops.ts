/**
 * Gitea write/read operations for the it-ops broker.
 *
 * Runs IN the Claudable process (not the agent) — the agent calls a broker tool
 * and gets only the result; the GIT_TOKEN never enters the scrubbed agent env.
 *
 * Reuses Claudable's existing git-provider config + token (the same credential
 * the app already uses to create repos and push deploys), so this grants the
 * broker no access Claudable didn't already hold.
 */
import { getGitProviderConfig, getEnvGitToken } from '../git-provider';

export interface GiteaResult {
  ok: boolean;
  message: string;
}

function authHeaders(): Record<string, string> | null {
  const token = getEnvGitToken();
  if (!token) return null;
  const { authScheme } = getGitProviderConfig();
  return {
    Authorization: `${authScheme} ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/** owner defaults to the configured org (or must be passed for user-owned repos). Shared with gitea-admin-ops. */
export function ownerOrThrow(owner?: string): string {
  const resolved = owner?.trim() || getGitProviderConfig().org;
  if (!resolved) throw new Error('No repo owner: pass owner or set GIT_ORG.');
  return resolved;
}

/** Low-level Gitea API call (auth + base URL). Exported for the admin ops module. */
export async function api(path: string, init?: RequestInit): Promise<unknown> {
  const headers = authHeaders();
  if (!headers) throw new Error('Gitea not configured (no GIT_TOKEN).');
  const { apiBaseUrl } = getGitProviderConfig();
  const res = await fetch(`${apiBaseUrl}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
  const body = await res.text();
  if (!res.ok) throw new Error(`Gitea ${res.status}: ${body.slice(0, 300)}`);
  return body.length ? JSON.parse(body) : null;
}

export async function listRepos(owner?: string): Promise<string> {
  const org = owner?.trim() || getGitProviderConfig().org;
  const path = org ? `/orgs/${encodeURIComponent(org)}/repos` : '/user/repos';
  const repos = (await api(path)) as Array<{ full_name: string; private: boolean; html_url: string }>;
  if (!repos.length) return 'No repositories.';
  return repos.map((r) => `- ${r.full_name}${r.private ? ' (private)' : ''} — ${r.html_url}`).join('\n');
}

export async function readFile(repo: string, path: string, ref?: string, owner?: string): Promise<string> {
  const o = ownerOrThrow(owner);
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const file = (await api(
    `/repos/${encodeURIComponent(o)}/${encodeURIComponent(repo)}/contents/${path}${q}`,
  )) as { content?: string; encoding?: string };
  if (!file.content) return '(empty or not a file)';
  return Buffer.from(file.content, (file.encoding as BufferEncoding) || 'base64').toString('utf8');
}

/** Create or update a file (commits on `branch`, default the repo default). */
export async function writeFile(
  repo: string,
  path: string,
  content: string,
  message: string,
  branch?: string,
  owner?: string,
): Promise<GiteaResult> {
  const o = ownerOrThrow(owner);
  const contentsPath = `/repos/${encodeURIComponent(o)}/${encodeURIComponent(repo)}/contents/${path}`;

  // A PUT updates if it exists (needs the blob sha) or creates if not.
  let sha: string | undefined;
  try {
    const q = branch ? `?ref=${encodeURIComponent(branch)}` : '';
    const existing = (await api(`${contentsPath}${q}`)) as { sha?: string };
    sha = existing.sha;
  } catch {
    sha = undefined; // not found → create
  }

  const payload = {
    content: Buffer.from(content, 'utf8').toString('base64'),
    message,
    ...(branch ? { branch } : {}),
    ...(sha ? { sha } : {}),
  };
  await api(contentsPath, { method: 'PUT', body: JSON.stringify(payload) });
  return { ok: true, message: `${sha ? 'Updated' : 'Created'} ${o}/${repo}:${path}${branch ? ` on ${branch}` : ''}` };
}

export async function createRepo(name: string, opts?: { private?: boolean; description?: string }): Promise<GiteaResult> {
  const { org } = getGitProviderConfig();
  const path = org ? `/orgs/${encodeURIComponent(org)}/repos` : '/user/repos';
  const created = (await api(path, {
    method: 'POST',
    body: JSON.stringify({ name, private: opts?.private ?? true, description: opts?.description ?? '', auto_init: false }),
  })) as { full_name: string; html_url: string };
  return { ok: true, message: `Created ${created.full_name} — ${created.html_url}` };
}
