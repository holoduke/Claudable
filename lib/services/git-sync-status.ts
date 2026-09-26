/**
 * Behind-detection for a project's git connection: is the remote branch ahead
 * of the local working copy? Read-only and cheap — one provider API call for
 * the remote branch head plus local `git rev-parse`/`merge-base`; no fetch, no
 * lock, nothing in the working tree is touched. The chat UI polls this and
 * offers "Update" (the existing pull route) when the project is behind.
 */
import { getProjectById } from './project';
import { getProjectService } from './project-services';
import { getGitProviderConfigFor } from './git-provider';
import { GitHubError, resolveGitToken, githubFetch, projectGitBranch, resolveProjectRepoPath } from './github';
import { getHeadCommit, historyContains, countDirtyFiles, countCommitsAhead } from './git';

export interface RemoteSyncStatus {
  /** False when the project has no git connection — nothing to compare. */
  connected: boolean;
  branch: string | null;
  /** True when the remote branch has commits the local checkout lacks. */
  behind: boolean;
  /** How many commits behind, when the provider could tell us (else null). */
  behind_by: number | null;
  local_sha: string | null;
  remote_sha: string | null;
  /** True when this project holds work the published branch doesn't have. */
  unpublished: boolean;
  /** Committed-but-unpushed commits (null when it can't be determined). */
  ahead_by: number | null;
  /** Files edited since the last commit — the usual "not published yet" shape. */
  dirty_files: number;
}

const NOT_CONNECTED: RemoteSyncStatus = {
  connected: false,
  branch: null,
  behind: false,
  behind_by: null,
  local_sha: null,
  remote_sha: null,
  unpublished: false,
  ahead_by: null,
  dirty_files: 0,
};

/** Remote branch head sha. GitHub puts it in commit.sha, Gitea in commit.id. */
export function remoteHeadSha(branchInfo: unknown): string | null {
  const commit = (branchInfo as Record<string, any> | null)?.commit;
  if (typeof commit?.sha === 'string') return commit.sha;
  if (typeof commit?.id === 'string') return commit.id;
  return null;
}

/** Commits-behind count out of a compare-API response; the field differs per
 *  provider. Null when the response carries no usable count. */
export function parseCompareCount(cmp: unknown): number | null {
  const c = cmp as Record<string, any> | null;
  if (typeof c?.ahead_by === 'number') return c.ahead_by; // GitHub
  if (typeof c?.total_commits === 'number') return c.total_commits; // Gitea
  if (Array.isArray(c?.commits)) return c.commits.length;
  return null;
}

/** Commits-behind count via the provider's compare API; null when unknowable
 *  (e.g. the local sha only exists locally because an agent turn committed). */
async function compareBehindCount(
  token: string,
  cfg: ReturnType<typeof getGitProviderConfigFor>,
  owner: string,
  repo: string,
  localSha: string,
  remoteSha: string,
): Promise<number | null> {
  try {
    const cmp = await githubFetch(
      token,
      `/repos/${owner}/${repo}/compare/${localSha}...${remoteSha}`,
      undefined,
      cfg,
    );
    return parseCompareCount(cmp);
  } catch {
    return null;
  }
}

export async function getProjectSyncStatus(projectId: string): Promise<RemoteSyncStatus> {
  const project = await getProjectById(projectId);
  if (!project) return NOT_CONNECTED;

  const service = await getProjectService(projectId, 'github');
  const data = service?.serviceData as Record<string, any> | undefined;
  if (!data?.clone_url || !data?.owner || !data?.repo_name) return NOT_CONNECTED;

  const cfg = getGitProviderConfigFor(data);
  const token = await resolveGitToken(cfg);
  const branch = projectGitBranch(data);

  let branchInfo: unknown = null;
  let notPublished = false;
  try {
    branchInfo = await githubFetch(
      token,
      `/repos/${data.owner}/${data.repo_name}/branches/${encodeURIComponent(branch)}`,
      undefined,
      cfg,
    );
  } catch (error) {
    // A branch created in Claudable that hasn't been published yet.
    if (!(error instanceof GitHubError && error.status === 404)) throw error;
    notPublished = true;
  }
  const remoteSha = remoteHeadSha(branchInfo);

  const repoPath = resolveProjectRepoPath(projectId, project.repoPath);
  const localSha = getHeadCommit(repoPath);
  if (notPublished) {
    return {
      connected: true, branch, local_sha: localSha, remote_sha: null, unpublished: true,
      ahead_by: null, dirty_files: countDirtyFiles(repoPath), behind: false, behind_by: null,
    };
  }

  // What this project holds that the published branch doesn't: uncommitted
  // edits (the normal state right after an agent turn) plus any commits the
  // remote is missing. Both are cheap local git calls.
  const dirtyFiles = countDirtyFiles(repoPath);
  const aheadBy = remoteSha ? countCommitsAhead(repoPath, remoteSha) : null;
  const unpublished = dirtyFiles > 0 || (aheadBy ?? 0) > 0;

  const base = {
    connected: true,
    branch,
    local_sha: localSha,
    remote_sha: remoteSha,
    unpublished,
    ahead_by: aheadBy,
    dirty_files: dirtyFiles,
  };

  if (!remoteSha) {
    // Remote branch head unreadable — can't claim anything, stay quiet.
    return { ...base, behind: false, behind_by: null };
  }
  if (!localSha) {
    // A connected project without local history is by definition behind.
    return { ...base, behind: true, behind_by: null };
  }
  if (localSha === remoteSha || historyContains(repoPath, remoteSha)) {
    // Up to date, or the local copy is only AHEAD (unpushed work) — not behind.
    return { ...base, behind: false, behind_by: 0 };
  }

  const behindBy = await compareBehindCount(token, cfg, data.owner, data.repo_name, localSha, remoteSha);
  return { ...base, behind: true, behind_by: behindBy };
}
