import path from 'path';
import fs from 'fs/promises';
import { getPlainServiceToken } from '@/lib/services/tokens';
import { getProjectById, updateProject } from '@/lib/services/project';
import { getProjectService, upsertProjectServiceConnection, updateProjectServiceData } from '@/lib/services/project-services';
import { ensureGitRepository, ensureGitConfig, initializeMainBranch, addOrUpdateRemote, commitAll, pushToRemote } from '@/lib/services/git';
import { getGitProviderConfig, getEnvGitToken } from '@/lib/services/git-provider';
import { injectDeployScaffolding } from '@/lib/services/scaffold-deploy';
import type { GitHubUserInfo, CreateRepoOptions, GitHubRepositoryInfo } from '@/types/shared';

class GitHubError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GitHubError';
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

export async function ensureProjectRepository(projectId: string, repoPath?: string | null) {
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
  await injectDeployScaffolding(repoPath, { repoName: options.repoName });

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

export async function pushProjectToGitHub(projectId: string) {
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
    await injectDeployScaffolding(repoPath, { repoName });

    const committed = commitAll(repoPath, 'Update from Claudable');
    if (!committed) {
      console.log('[GitService] No changes to commit before push');
      return;
    }

    // Basic-auth the push with the token. The username must be the token-owning
    // user (not the org) for Gitea/GitHub basic auth to succeed.
    const authenticatedUrl = String(data.clone_url).replace('https://', `https://${encodeURIComponent(user.login)}:${token}@`);
    pushToRemote(repoPath, 'origin', data.default_branch || 'main', authenticatedUrl);

    await updateProjectServiceData(projectId, 'github', {
      last_pushed_at: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof GitHubError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new GitHubError(`Failed to push project to GitHub: ${message}`);
  }
}
