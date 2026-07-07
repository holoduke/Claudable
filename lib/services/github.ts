import path from 'path';
import fs from 'fs/promises';
import { getPlainServiceToken } from '@/lib/services/tokens';
import { getProjectById, updateProject } from '@/lib/services/project';
import { getProjectService, upsertProjectServiceConnection, updateProjectServiceData } from '@/lib/services/project-services';
import { clampAutoSyncMinutes, AUTO_SYNC_DEFAULT_MINUTES } from '@/lib/services/auto-sync-schedule';
import { ensureGitRepository, ensureGitConfig, initializeMainBranch, addOrUpdateRemote, commitAll, pushToRemote, pullFromRemote, checkoutRemoteBranch } from '@/lib/services/git';
import { getGitProviderConfig, getEnvGitToken } from '@/lib/services/git-provider';
import { injectDeployScaffolding } from '@/lib/services/scaffold-deploy';
import { getDatabaseUrl } from '@/lib/services/database';
import type { GitHubUserInfo, CreateRepoOptions, GitHubRepositoryInfo } from '@/types/shared';

class GitHubError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GitHubError';
  }
}

// Per-project serialization of git working-tree operations (push, pull). Push
// (chat header / auto-push after a turn) and Sync (settings) both `git add -A`
// + commit + merge/push in the SAME checkout; interleaving them commits
// conflict markers or trips index.lock. Chained promise per project = a mutex
// without a dependency. Keyed by projectId; entries are short-lived.
const gitLocks = new Map<string, Promise<unknown>>();

async function withGitLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = gitLocks.get(projectId) ?? Promise.resolve();
  // Swallow the previous op's rejection so one failure doesn't chain-reject
  // every queued op; each caller still sees its own fn's result/throw.
  const run = prev.catch(() => {}).then(fn);
  gitLocks.set(projectId, run);
  try {
    return await run;
  } finally {
    if (gitLocks.get(projectId) === run) {
      gitLocks.delete(projectId);
    }
  }
}

/** Resolve the API token: env (server automation) first, then DB-stored token. */
async function resolveGitToken(): Promise<string> {
  const envToken = getEnvGitToken();
  if (envToken) {
    return envToken;
  }
  const dbToken = await getPlainServiceToken('github');
  if (!dbToken) {
    throw new GitHubError('Git provider token not configured', 401);
  }
  return dbToken;
}

/** Owner that repos are created/looked-up under: configured org, else the user. */
async function resolveOwner(): Promise<string> {
  const { org } = getGitProviderConfig();
  if (org) {
    return org;
  }
  const user = await getGithubUser();
  return user.login;
}

async function githubFetch(token: string, endpoint: string, init?: RequestInit) {
  const { apiBaseUrl, authScheme } = getGitProviderConfig();
  const response = await fetch(`${apiBaseUrl}${endpoint}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      // Required so Gitea/GitHub parse the JSON request body. Without it, POST
      // bodies (e.g. repo creation) are ignored and the API returns a 422 for
      // "missing" fields — which surfaced as a misleading "already exists".
      'Content-Type': 'application/json',
      Authorization: `${authScheme} ${token}`,
      'User-Agent': 'Claudable-Next',
      ...init?.headers,
    },
  });

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const body: any = response.status === 204
    ? null
    : isJson
    ? await response.json().catch(() => null)
    : await response.text();

  if (!response.ok) {
    let message = 'GitHub API request failed';
    if (body) {
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object') {
        const errorMessage = (body as Record<string, unknown>).message;
        const errors = (body as Record<string, unknown>).errors;
        if (typeof errorMessage === 'string' && errorMessage.trim().length > 0) {
          message = errorMessage;
        } else if (Array.isArray(errors) && errors.length > 0) {
          const aggregated = errors
            .map((err) => (err && typeof err === 'object' ? (err as Record<string, unknown>).message : null))
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .join(', ');
          if (aggregated) {
            message = aggregated;
          }
        } else {
          message = JSON.stringify(body);
        }
      }
    }
    throw new GitHubError(message, response.status);
  }

  return body;
}

export async function getGithubUser(): Promise<GitHubUserInfo> {
  const token = await resolveGitToken();

  const data = (await githubFetch(token, '/user')) as any;
  return {
    login: data.login,
    // GitHub returns `name`; Gitea uses `full_name`.
    name: data.name || data.full_name || data.login,
    email: data.email,
  };
}

export async function checkRepositoryAvailability(repoName: string) {
  const token = await resolveGitToken();

  const owner = await resolveOwner();
  try {
    await githubFetch(token, `/repos/${owner}/${repoName}`);
    return { exists: true, username: owner };
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      return { exists: false, username: owner };
    }
    throw error;
  }
}

export async function createRepository(options: CreateRepoOptions) {
  const token = await resolveGitToken();
  const { org } = getGitProviderConfig();

  const payload = {
    name: options.repoName,
    description: options.description ?? '',
    private: options.private ?? false,
    auto_init: false,
  };

  // Create under the org when configured, otherwise under the authenticated user.
  // Both GitHub and Gitea expose `/orgs/{org}/repos` and `/user/repos`.
  const endpoint = org ? `/orgs/${org}/repos` : '/user/repos';

  try {
    const repo = await githubFetch(token, endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return repo as any;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 422) {
      throw new GitHubError(`Repository name "${options.repoName}" is unavailable or already exists.`, error.status);
    }
    throw error;
  }
}

function resolveProjectRepoPath(projectId: string, repoPath?: string | null) {
  if (repoPath) {
    return path.isAbsolute(repoPath) ? repoPath : path.resolve(process.cwd(), repoPath);
  }
  return path.resolve(process.cwd(), process.env.PROJECTS_DIR || './data/projects', projectId);
}

async function ensureProjectRepository(projectId: string, repoPath?: string | null) {
  const resolved = resolveProjectRepoPath(projectId, repoPath);
  await fs.mkdir(resolved, { recursive: true });
  return resolved;
}

export async function getGithubRepositoryDetails(owner: string, repo: string): Promise<GitHubRepositoryInfo> {
  const token = await resolveGitToken();

  try {
    const data = (await githubFetch(token, `/repos/${owner}/${repo}`)) as any;
    if (!data || typeof data.id !== 'number') {
      throw new GitHubError('GitHub repository not found', 404);
    }

    return {
      id: data.id,
      name: data.name,
      full_name: data.full_name,
      owner: {
        login: data.owner?.login ?? owner,
        id: typeof data.owner?.id === 'number' ? data.owner.id : null,
      },
      default_branch: data.default_branch,
    };
  } catch (error) {
    if (error instanceof GitHubError) {
      if (error.status === 404) {
        throw new GitHubError('GitHub repository not found', 404);
      }
      throw error;
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new GitHubError(`Failed to fetch repository metadata: ${message}`);
  }
}

export async function connectProjectToGitHub(projectId: string, options: CreateRepoOptions) {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  await resolveGitToken();

  const user = await getGithubUser();
  const repo = await createRepository(options);

  const repoPath = await ensureProjectRepository(projectId, project.repoPath);
  ensureGitRepository(repoPath);
  const repoUrl = repo.html_url as string;
  const cloneUrl = repo.clone_url as string;
  const defaultBranch = (repo.default_branch as string) || 'main';
  // Repos created under an org are owned by the org, not the user.
  const owner = (repo.owner?.login as string) || (await resolveOwner());

  await updateProject(projectId, { repoPath });

  const userName = user.name || user.login;
  const userEmail = user.email || `${user.login}@users.noreply.github.com`;

  ensureGitConfig(repoPath, userName, userEmail);
  initializeMainBranch(repoPath);

  // Inject self-hosted deploy scaffolding (Dockerfile, compose, Gitea Actions
  // workflow) so push-to-main auto-deploys at <site>.<deploy-domain>.
  await injectDeployScaffolding(repoPath, { repoName: options.repoName, templateType: project.templateType });

  addOrUpdateRemote(repoPath, 'origin', cloneUrl);
  commitAll(repoPath, 'Initial commit - connected to Claudable');

  await upsertProjectServiceConnection(projectId, 'github', {
    repo_url: repoUrl,
    repo_name: options.repoName,
    clone_url: cloneUrl,
    default_branch: defaultBranch,
    owner,
  });

  return {
    repo_url: repoUrl,
    clone_url: cloneUrl,
    default_branch: defaultBranch,
    owner,
  };
}

// Git's own ref rules are looser, but this covers real-world branch names and
// blocks anything that could smuggle git options or path tricks. Enforced BOTH
// at write time (setProjectGitBranch) and at every use site (projectGitBranch),
// so a branch injected into service_data by any other path can never reach a
// git argv as `--upload-pack=…` or similar. Starts with an alnum → never a `-`.
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

/**
 * The branch this project operates on: push target AND sync (pull) source.
 * Per-project override in service_data.branch, falling back to the repo's
 * default branch, then 'main'. A stored value that fails validation is ignored
 * (falls through to default_branch/main) rather than trusted — the value flows
 * into `git fetch <url> <branch>` as bare argv.
 */
export function projectGitBranch(data: Record<string, any> | undefined): string {
  const candidate = typeof data?.branch === 'string' ? data.branch.trim() : '';
  if (candidate && BRANCH_NAME_RE.test(candidate) && !candidate.includes('..')) {
    return candidate;
  }
  const def = typeof data?.default_branch === 'string' ? data.default_branch.trim() : '';
  if (def && BRANCH_NAME_RE.test(def) && !def.includes('..')) {
    return def;
  }
  return 'main';
}

export interface ProjectGitSettings {
  repo_url: string | null;
  repo_name: string | null;
  owner: string | null;
  default_branch: string;
  branch: string;
  last_pushed_at: string | null;
  last_synced_at: string | null;
  auto_sync: boolean;
  auto_sync_interval_minutes: number;
}

export async function getProjectGitSettings(projectId: string): Promise<ProjectGitSettings> {
  const service = await getProjectService(projectId, 'github');
  const data = service?.serviceData as Record<string, any> | undefined;
  if (!data?.clone_url) {
    throw new GitHubError('Git repository not connected', 404);
  }
  return {
    repo_url: (data.repo_url as string) ?? null,
    repo_name: (data.repo_name as string) ?? null,
    owner: (data.owner as string) ?? null,
    default_branch: (data.default_branch as string) || 'main',
    branch: projectGitBranch(data),
    last_pushed_at: (data.last_pushed_at as string) ?? null,
    last_synced_at: (data.last_synced_at as string) ?? null,
    auto_sync: data.auto_sync === true,
    auto_sync_interval_minutes: clampAutoSyncMinutes(
      data.auto_sync_interval_minutes ?? AUTO_SYNC_DEFAULT_MINUTES,
    ),
  };
}

/**
 * Toggle background auto-sync (periodic pull) for a project and/or set its
 * cadence. Only the fields provided are changed. Requires a connected repo.
 * Returns the effective settings.
 */
export async function setProjectAutoSync(
  projectId: string,
  opts: { enabled?: boolean; intervalMinutes?: number },
): Promise<{ auto_sync: boolean; auto_sync_interval_minutes: number }> {
  const service = await getProjectService(projectId, 'github');
  const data = service?.serviceData as Record<string, any> | undefined;
  if (!data?.clone_url) {
    throw new GitHubError('Git repository not connected', 404);
  }
  const patch: Record<string, unknown> = {};
  if (typeof opts.enabled === 'boolean') patch.auto_sync = opts.enabled;
  if (opts.intervalMinutes !== undefined) {
    patch.auto_sync_interval_minutes = clampAutoSyncMinutes(opts.intervalMinutes);
  }
  if (Object.keys(patch).length > 0) {
    await updateProjectServiceData(projectId, 'github', patch);
  }
  const next = { ...data, ...patch };
  return {
    auto_sync: next.auto_sync === true,
    auto_sync_interval_minutes: clampAutoSyncMinutes(
      next.auto_sync_interval_minutes ?? AUTO_SYNC_DEFAULT_MINUTES,
    ),
  };
}

/**
 * Set the branch this project pushes to and syncs from. Validates the name and
 * checks the branch actually exists on the remote before saving.
 */
export async function setProjectGitBranch(projectId: string, branch: string): Promise<string> {
  const trimmed = branch.trim();
  if (!BRANCH_NAME_RE.test(trimmed) || trimmed.includes('..')) {
    throw new GitHubError(`Invalid branch name: "${branch}"`, 400);
  }
  const service = await getProjectService(projectId, 'github');
  const data = service?.serviceData as Record<string, any> | undefined;
  if (!data?.owner || !data?.repo_name) {
    throw new GitHubError('Git repository not connected', 404);
  }
  const token = await resolveGitToken();
  try {
    // Both GitHub and Gitea expose /repos/{owner}/{repo}/branches/{branch}.
    await githubFetch(token, `/repos/${data.owner}/${data.repo_name}/branches/${encodeURIComponent(trimmed)}`);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      throw new GitHubError(`Branch "${trimmed}" does not exist on ${data.owner}/${data.repo_name}`, 404);
    }
    throw error;
  }
  await updateProjectServiceData(projectId, 'github', { branch: trimmed });

  // Realign the local checkout to the newly-selected branch so the next
  // sync/push operates on that branch's history, not the previous one. Under
  // the git lock (shares the working tree with push/pull); best-effort and
  // non-destructive (skips on a dirty tree).
  if (projectGitBranch(data) !== trimmed) {
    await withGitLock(projectId, async () => {
      try {
        const project = await getProjectById(projectId);
        if (!project) return;
        const repoPath = await ensureProjectRepository(projectId, project.repoPath);
        ensureGitRepository(repoPath);
        const authenticatedUrl = String(data.clone_url).replace(
          'https://',
          `https://${encodeURIComponent((await getGithubUser()).login)}:${token}@`,
        );
        checkoutRemoteBranch(repoPath, trimmed, authenticatedUrl);
      } catch (e) {
        // Non-fatal: the branch setting is saved; the next Sync reconciles.
        console.warn('[GitService] Could not realign local checkout to new branch:', e instanceof Error ? e.message : e);
      }
    });
  }
  return trimmed;
}

export interface SyncResult {
  /** Whether the pull changed the local project (false = already up to date). */
  updated: boolean;
  branch: string;
  message: string;
  /** True when the merge touched a dependency manifest → deps need reinstall. */
  dependenciesChanged: boolean;
}

// Manifests whose change means the preview needs a dependency reinstall.
const DEP_MANIFESTS = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'go.mod', 'go.sum', 'requirements.txt', 'pyproject.toml', 'poetry.lock',
];

/**
 * Sync (pull) the project from its remote branch: local edits are committed
 * first, then the remote branch is fetched and merged (fast-forward when
 * possible). A merge conflict aborts cleanly and surfaces as an error — the
 * working tree is never left half-merged.
 */
export async function pullProjectFromGitHub(projectId: string): Promise<SyncResult> {
  return withGitLock(projectId, () => pullProjectFromGitHubImpl(projectId));
}

async function pullProjectFromGitHubImpl(projectId: string): Promise<SyncResult> {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error('Project not found');
  }
  const token = await resolveGitToken();
  const service = await getProjectService(projectId, 'github');
  const data = service?.serviceData as Record<string, any> | undefined;
  if (!data?.clone_url || !data?.owner) {
    throw new GitHubError('Git repository not connected', 404);
  }

  const repoPath = await ensureProjectRepository(projectId, project.repoPath);
  ensureGitRepository(repoPath);
  const user = await getGithubUser();
  ensureGitConfig(repoPath, user.name || user.login, user.email || `${user.login}@users.noreply.github.com`);

  const branch = projectGitBranch(data);
  // Commit local edits first so the merge weaves remote changes into them
  // instead of refusing to run on a dirty tree.
  commitAll(repoPath, 'Local changes before sync');

  const authenticatedUrl = String(data.clone_url).replace('https://', `https://${encodeURIComponent(user.login)}:${token}@`);
  const result = pullFromRemote(repoPath, 'origin', branch, authenticatedUrl);

  await updateProjectServiceData(projectId, 'github', {
    last_synced_at: new Date().toISOString(),
  });

  const dependenciesChanged = result.changedFiles.some((f) => DEP_MANIFESTS.includes(path.basename(f)));

  return {
    updated: result.updated,
    branch,
    dependenciesChanged,
    message: result.updated
      ? `Synced with ${branch} (${(result.after ?? '').slice(0, 7)})`
      : `Already up to date with ${branch}`,
  };
}

/** @returns whether new changes were actually pushed (false = already up to date). */
export async function pushProjectToGitHub(projectId: string): Promise<boolean> {
  return withGitLock(projectId, () => pushProjectToGitHubImpl(projectId));
}

async function pushProjectToGitHubImpl(projectId: string): Promise<boolean> {
  try {
    const project = await getProjectById(projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    const token = await resolveGitToken();

    const service = await getProjectService(projectId, 'github');
    const data = service?.serviceData as Record<string, any> | undefined;
    if (!data?.clone_url || !data?.owner) {
      throw new GitHubError('Git repository not connected', 404);
    }

    const repoPath = await ensureProjectRepository(projectId, project.repoPath);
    ensureGitRepository(repoPath);
    const user = await getGithubUser();
    const userName = user.name || user.login;
    const userEmail = user.email || `${user.login}@users.noreply.github.com`;
    ensureGitConfig(repoPath, userName, userEmail);

    // Keep deploy scaffolding present even if the agent edited the project.
    const repoName = (data.repo_name as string) || path.basename(repoPath);
    await injectDeployScaffolding(repoPath, { repoName, templateType: project.templateType });

    const committed = commitAll(repoPath, 'Update from Claudable');
    if (!committed) {
      console.log('[GitService] No changes to commit before push');
      return false;
    }

    // If a Postgres was provisioned, sync its DATABASE_URL as a repo Action secret
    // so the deploy workflow injects it into the deployed app's runtime env.
    try {
      const dbUrl = await getDatabaseUrl(projectId);
      if (dbUrl) {
        await githubFetch(token, `/repos/${data.owner}/${repoName}/actions/secrets/DATABASE_URL`, {
          method: 'PUT',
          body: JSON.stringify({ data: dbUrl }),
        });
      }
    } catch (e) {
      console.warn('[GitService] Could not sync DATABASE_URL secret:', e instanceof Error ? e.message : e);
    }

    // Basic-auth the push with the token. The username must be the token-owning
    // user (not the org) for Gitea/GitHub basic auth to succeed.
    const authenticatedUrl = String(data.clone_url).replace('https://', `https://${encodeURIComponent(user.login)}:${token}@`);
    pushToRemote(repoPath, 'origin', projectGitBranch(data), authenticatedUrl);

    await updateProjectServiceData(projectId, 'github', {
      last_pushed_at: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    if (error instanceof GitHubError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new GitHubError(`Failed to push project to GitHub: ${message}`);
  }
}

export interface DeployRunStatus {
  found: boolean;
  /** Normalized run state. */
  state: 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'unknown';
  runNumber?: number;
  /** Link to the CI run page (the user's own Git server). */
  url?: string;
  /** Commit message of the deployed run. */
  title?: string;
  /** Short commit SHA of the deployed run. */
  sha?: string;
  startedAt?: string;
  updatedAt?: string;
  /** The site's live URL once deployed. */
  liveUrl?: string;
}

/**
 * Read the latest CI deploy run for a project's repo (self-hosted Gitea
 * Actions). This is the real deployment status — not a guess — so the UI can
 * show queued -> running -> success/failure and link to the run log.
 */
export async function getDeployRunStatus(projectId: string): Promise<DeployRunStatus> {
  const { provider, deployDomain } = getGitProviderConfig();
  if (provider !== 'gitea') {
    return { found: false, state: 'unknown' };
  }

  const service = await getProjectService(projectId, 'github');
  const data = service?.serviceData as Record<string, any> | undefined;
  const owner = data?.owner as string | undefined;
  const repo = data?.repo_name as string | undefined;
  if (!owner || !repo) {
    return { found: false, state: 'unknown' };
  }

  let body: any;
  try {
    const token = await resolveGitToken();
    body = await githubFetch(token, `/repos/${owner}/${repo}/actions/tasks?limit=1`);
  } catch {
    return { found: false, state: 'unknown' };
  }

  const run = (body?.workflow_runs ?? [])[0];
  if (!run) {
    return { found: false, state: 'unknown' };
  }

  const raw = String(run.status ?? '').toLowerCase();
  const state: DeployRunStatus['state'] =
    raw === 'success' ? 'success'
    : raw === 'failure' || raw === 'error' ? 'failure'
    : raw === 'cancelled' || raw === 'canceled' ? 'cancelled'
    : raw === 'running' || raw === 'in_progress' ? 'running'
    : raw === 'waiting' || raw === 'queued' || raw === 'blocked' ? 'queued'
    : 'unknown';

  return {
    found: true,
    state,
    runNumber: typeof run.run_number === 'number' ? run.run_number : undefined,
    url: typeof run.url === 'string' ? run.url : undefined,
    title: typeof run.display_title === 'string' ? run.display_title : undefined,
    sha: typeof run.head_sha === 'string' ? run.head_sha.slice(0, 7) : undefined,
    startedAt: run.run_started_at,
    updatedAt: run.updated_at,
    liveUrl: deployDomain ? `https://${repo}.${deployDomain}` : undefined,
  };
}
