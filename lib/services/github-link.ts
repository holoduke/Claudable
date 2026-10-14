/**
 * Link a project to a repository that already exists on github.com (e.g. one
 * New Story's DevOps created for a project moving off the sandbox), instead of
 * creating a new repo on this instance's git server.
 *
 * Access is checked with the same credentials publishing will use (the GitHub
 * App when it is installed on the repo, else the GitHub token), so a link that
 * succeeds can also push.
 */

import { addOrUpdateRemote, ensureGitRepository, historyContains } from '@/lib/services/git';
import { getGitProviderConfig } from '@/lib/services/git-provider';
import { GitHubError, ensureProjectRepository, githubFetch, resolveRepoAuth } from '@/lib/services/github';
import { getProjectById } from '@/lib/services/project';
import { getProjectService, upsertProjectServiceConnection } from '@/lib/services/project-services';

const SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/u;

export interface LinkGithubRepoInput {
  owner: string;
  repo: string;
  /** 'pr' when the default branch only accepts pull requests (org ruleset). */
  pushMode?: 'direct' | 'pr';
  /** Replace an existing connection to another repository. */
  force?: boolean;
}

export interface LinkGithubRepoResult {
  owner: string;
  repo: string;
  repoUrl: string;
  defaultBranch: string;
  via: 'github-app' | 'token';
  /** Set when publishing needs attention first. */
  warning: string | null;
}

/** Accepts `owner/repo`, `https://github.com/owner/repo(.git)` or separate parts. */
export function parseGithubRepo(input: string): { owner: string; repo: string } | null {
  const text = String(input ?? '').trim().replace(/\.git$/u, '').replace(/\/+$/u, '');
  const match = /^(?:https:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+)$/u.exec(text);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

export async function linkProjectToGithubRepo(projectId: string, input: LinkGithubRepoInput): Promise<LinkGithubRepoResult> {
  const parsed = parseGithubRepo(`${input.owner}/${input.repo}`);
  if (!parsed) throw new GitHubError('Enter the repository as owner/name, e.g. new-story/storyloop.', 400);
  const project = await getProjectById(projectId);
  if (!project) throw new GitHubError('Project not found', 404);

  const existing = (await getProjectService(projectId, 'github'))?.serviceData as Record<string, unknown> | undefined;
  const current = typeof existing?.repo_url === 'string' ? existing.repo_url : typeof existing?.clone_url === 'string' ? existing.clone_url : '';
  const sameRepo = parseGithubRepo(String(existing?.clone_url ?? ''));
  const isSame = sameRepo?.owner.toLowerCase() === parsed.owner.toLowerCase() && sameRepo?.repo.toLowerCase() === parsed.repo.toLowerCase();
  if (current && !isSame && !input.force) {
    throw new GitHubError(`This project is already connected to ${current}. Confirm to replace that connection.`, 409);
  }

  const override = getGitProviderConfig().provider === 'github' ? {} : { provider_override: 'github' };
  const probe = { ...override, owner: parsed.owner, repo_name: parsed.repo };
  const auth = await resolveRepoAuth(probe);

  let repo: any;
  try {
    repo = await githubFetch(auth.token, `/repos/${parsed.owner}/${parsed.repo}`, undefined, auth.cfg);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      throw new GitHubError(`Repository ${parsed.owner}/${parsed.repo} was not found, or Claudable has no access to it.`, 404);
    }
    throw error;
  }
  if (typeof repo?.clone_url !== 'string' || !repo.clone_url.startsWith('https://github.com/')) {
    throw new GitHubError('GitHub returned an unexpected repository.', 502);
  }
  const owner = String(repo.owner?.login ?? parsed.owner);
  const name = String(repo.name ?? parsed.repo);
  const defaultBranch = typeof repo.default_branch === 'string' && repo.default_branch ? repo.default_branch : 'main';

  const repoPath = await ensureProjectRepository(projectId, project.repoPath);
  ensureGitRepository(repoPath);
  const warning = await divergenceWarning(auth, owner, name, defaultBranch, repoPath);

  addOrUpdateRemote(repoPath, 'origin', repo.clone_url);
  await upsertProjectServiceConnection(projectId, 'github', {
    ...override,
    owner,
    repo_name: name,
    repo_url: typeof repo.html_url === 'string' ? repo.html_url : `https://github.com/${owner}/${name}`,
    clone_url: repo.clone_url,
    default_branch: defaultBranch,
    ...(input.pushMode === 'pr' ? { push_mode: 'pr' } : {}),
    linked_at: new Date().toISOString(),
  });

  return { owner, repo: name, repoUrl: repo.html_url ?? `https://github.com/${owner}/${name}`, defaultBranch, via: auth.via, warning };
}

/** A remote default branch with commits this project doesn't have can't take a plain push. */
async function divergenceWarning(
  auth: Awaited<ReturnType<typeof resolveRepoAuth>>,
  owner: string,
  repo: string,
  branch: string,
  repoPath: string,
): Promise<string | null> {
  let head: any;
  try {
    head = await githubFetch(auth.token, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`, undefined, auth.cfg);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null; // empty repo: the first publish creates the branch
    return null;
  }
  const sha = typeof head?.commit?.sha === 'string' ? head.commit.sha : '';
  if (!sha || historyContains(repoPath, sha)) return null;
  return `${owner}/${repo} already has commits on ${branch} that this project doesn't have. Use Sync first to merge them, then publish.`;
}
