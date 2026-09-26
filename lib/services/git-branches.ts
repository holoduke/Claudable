/**
 * Branches for the project toolbar: list / switch / create / merge-into-base.
 *
 * Every project has a LOCAL git repository (ensureLocalGit); a remote (Gitea or
 * GitHub, the "github" service connection) is optional:
 *  - local-only: branches live in the project's own .git; "merge into main" is a
 *    local merge.
 *  - with a remote: the current branch is also the publish target (Publish =
 *    push), and "merge into main" publishes the branch and merges it through a
 *    pull request on the repo host, so the host's CI/deploy runs as usual.
 *
 * The working tree is shared by the preview, the agent and everyone viewing the
 * project, so a switch always commits pending work first (never discards it), is
 * refused while an agent turn is running, and restarts the preview when files
 * changed. All tree operations run under the same per-project git lock as
 * publish/sync.
 */
import fs from 'fs';
import path from 'path';
import {
  adoptBranchName, commitAll, createLocalBranch, currentLocalBranch, ensureGitConfig, ensureGitRepository,
  fetchRemoteBranch, initializeMainBranch, isValidBranchName, localBranchNames, mergeLocalBranch,
  pathsChangedSinceMergeBase, switchLocalBranch, countDirtyFiles,
} from '@/lib/services/git';
import {
  GitHubError, ensureProjectRepository, getGithubUser, githubFetch, mergePublishPr, projectBaseBranch, projectGitBranch,
  pushProjectToGitHub, resolveGitToken, withGitLock,
} from '@/lib/services/github';
import { getProjectById } from '@/lib/services/project';
import { getProjectService, updateProjectServiceData } from '@/lib/services/project-services';
import { getGitProviderConfigFor } from '@/lib/services/git-provider';
import type { GitProviderConfig } from '@/lib/services/git-provider';
import { isAgentRunActive } from '@/lib/services/cli/run-registry';
import { isCustomerProject } from '@/lib/services/tenant-policy';
import { protectedPathsIn } from '@/lib/services/publish-guard';

const LOCAL_EXCLUDES = ['node_modules/', '.nuxt/', '.output/', '.data/', '.next/', '.angular/', '.svelte-kit/', '.cache/', 'dist/', '.vite/'];
const LOCAL_AUTHOR = { name: 'Claudable', email: 'claudable@users.noreply.local' };
const DEP_MANIFESTS = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.mod', 'go.sum', 'requirements.txt', 'pyproject.toml', 'poetry.lock', 'composer.json', 'composer.lock'];

export interface BranchInfo {
  name: string;
  local: boolean;
  remote: boolean;
  current: boolean;
  base: boolean;
}

export interface ProjectBranches {
  mode: 'local' | 'remote';
  current: string;
  base: string;
  branches: BranchInfo[];
  dirty_files: number;
  agent_busy: boolean;
  repo_url: string | null;
}

interface RemoteCtx {
  data: Record<string, any>;
  cfg: GitProviderConfig;
  token: string;
  owner: string;
  repo: string;
  authUrl: string;
  author: { name: string; email: string };
}

interface Ctx {
  repoPath: string;
  remote: RemoteCtx | null;
}

function branchError(message: string, status: number): GitHubError {
  return new GitHubError(message, status);
}

async function repoPathFor(projectId: string): Promise<string> {
  const project = await getProjectById(projectId);
  if (!project) throw branchError('Project not found', 404);
  return ensureProjectRepository(projectId, project.repoPath);
}

/**
 * Give the project a local git repository when it has none (every project is
 * git). Only after it has content — an early `git init` would write .gitignore
 * into the folder before the template scaffold, which refuses a non-empty dir.
 * Returns whether the project now has a repository.
 */
export async function ensureLocalGit(projectId: string): Promise<boolean> {
  const repoPath = await repoPathFor(projectId);
  if (fs.existsSync(path.join(repoPath, '.git'))) return true;
  const entries = fs.existsSync(repoPath) ? fs.readdirSync(repoPath).filter((e) => e !== '.DS_Store') : [];
  if (entries.length === 0) return false;
  return withGitLock(projectId, async () => {
    if (fs.existsSync(path.join(repoPath, '.git'))) return true;
    ensureGitRepository(repoPath);
    // Build/dev output never belongs in history. Local-only (.git/info/exclude):
    // the project's own .gitignore stays exactly as the project has it.
    const exclude = path.join(repoPath, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `\n# Claudable: build/dev output\n${LOCAL_EXCLUDES.join('\n')}\n`);
    ensureGitConfig(repoPath, LOCAL_AUTHOR.name, LOCAL_AUTHOR.email);
    commitAll(repoPath, 'Initial commit');
    initializeMainBranch(repoPath); // names the line of work `main`
    return true;
  });
}

async function loadCtx(projectId: string): Promise<Ctx> {
  const repoPath = await repoPathFor(projectId);
  if (!(await ensureLocalGit(projectId))) {
    throw branchError('This project has no files yet — start the preview or ask the agent to build something first.', 409);
  }
  const service = await getProjectService(projectId, 'github');
  const data = service?.serviceData as Record<string, any> | undefined;
  if (!data?.clone_url || !data?.owner || !data?.repo_name) {
    ensureGitConfig(repoPath, LOCAL_AUTHOR.name, LOCAL_AUTHOR.email);
    return { repoPath, remote: null };
  }
  const cfg = getGitProviderConfigFor(data);
  const token = await resolveGitToken(cfg);
  const user = await getGithubUser(cfg);
  const author = { name: user.name || user.login, email: user.email || `${user.login}@users.noreply.github.com` };
  ensureGitConfig(repoPath, author.name, author.email);
  const authUrl = String(data.clone_url).replace('https://', `https://${encodeURIComponent(user.login)}:${token}@`);
  return { repoPath, remote: { data, cfg, token, owner: String(data.owner), repo: String(data.repo_name), authUrl, author } };
}

/** The branch the project is on: the publish target with a remote, else local HEAD. */
function operatingBranch(ctx: Ctx): string {
  if (ctx.remote) return projectGitBranch(ctx.remote.data);
  return currentLocalBranch(ctx.repoPath) ?? 'main';
}

function localBase(repoPath: string): string {
  const names = localBranchNames(repoPath);
  return ['main', 'master'].find((n) => names.includes(n)) ?? currentLocalBranch(repoPath) ?? 'main';
}

function baseBranchOf(ctx: Ctx): string {
  return ctx.remote ? projectBaseBranch(ctx.remote.data) : localBase(ctx.repoPath);
}

async function remoteBranchNames(r: RemoteCtx): Promise<string[] | null> {
  const names: string[] = [];
  try {
    for (let page = 1; page <= 5; page++) {
      // Gitea pages with `limit`, GitHub with `per_page` — each ignores the other.
      const rows = await githubFetch(r.token, `/repos/${r.owner}/${r.repo}/branches?limit=100&per_page=100&page=${page}`, undefined, r.cfg);
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) if (typeof row?.name === 'string' && isValidBranchName(row.name)) names.push(row.name);
      if (rows.length < 100) break;
    }
    return names;
  } catch {
    return null; // host unreachable: show local branches only, don't fail the menu
  }
}

export async function listProjectBranches(projectId: string): Promise<ProjectBranches> {
  const ctx = await loadCtx(projectId);
  const current = operatingBranch(ctx);
  if (ctx.remote) {
    // Older checkouts publish HEAD:<branch> from a differently named local branch.
    await withGitLock(projectId, async () => adoptBranchName(ctx.repoPath, current));
  }
  const base = baseBranchOf(ctx);
  const local = localBranchNames(ctx.repoPath);
  const remote = ctx.remote ? await remoteBranchNames(ctx.remote) : [];
  const all = new Set([...local, ...(remote ?? []), current, base]);
  const branches = [...all].map((name) => ({
    name,
    local: local.includes(name),
    remote: remote === null ? false : remote.includes(name),
    current: name === current,
    base: name === base,
  })).sort((a, b) => Number(b.base) - Number(a.base) || Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
  return {
    mode: ctx.remote ? 'remote' : 'local',
    current,
    base,
    branches,
    dirty_files: countDirtyFiles(ctx.repoPath),
    agent_busy: isAgentRunActive(projectId),
    repo_url: ctx.remote ? (ctx.remote.data.repo_url as string) ?? null : null,
  };
}

function assertIdle(projectId: string): void {
  if (isAgentRunActive(projectId)) {
    throw branchError('The agent is still working on this project. Wait until it is done (or stop it), then switch branches.', 409);
  }
}

function assertBranchName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!isValidBranchName(trimmed)) {
    throw branchError('Invalid branch name. Use letters, digits, "-", "_", "." or "/" (e.g. feature/new-homepage).', 400);
  }
  return trimmed;
}

/** First time the branch changes: remember what "main" is for this project. */
async function rememberBase(projectId: string, ctx: Ctx): Promise<void> {
  if (ctx.remote && !ctx.remote.data.base_branch) {
    const base = projectGitBranch(ctx.remote.data);
    await updateProjectServiceData(projectId, 'github', { base_branch: base });
    ctx.remote.data = { ...ctx.remote.data, base_branch: base };
  }
}

export interface SwitchOutcome {
  branch: string;
  changed_files: number;
  dependencies_changed: boolean;
  diverged: boolean;
  preview_restarted: boolean;
  preview_error: string | null;
}

export async function switchProjectBranch(projectId: string, target: unknown): Promise<SwitchOutcome> {
  const branch = assertBranchName(target);
  assertIdle(projectId);
  const ctx = await loadCtx(projectId);
  const result = await withGitLock(projectId, async () => {
    assertIdle(projectId);
    const current = operatingBranch(ctx);
    if (current === branch && currentLocalBranch(ctx.repoPath) === branch) {
      return { changedFiles: [] as string[], diverged: false };
    }
    await rememberBase(projectId, ctx);
    commitAll(ctx.repoPath, `Work in progress on ${current}`);
    if (ctx.remote) adoptBranchName(ctx.repoPath, current);
    let switched;
    try {
      switched = switchLocalBranch(ctx.repoPath, branch, ctx.remote?.authUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw branchError(msg, /does not exist/.test(msg) ? 404 : 409);
    }
    if (ctx.remote) await updateProjectServiceData(projectId, 'github', { branch });
    return { changedFiles: switched.changedFiles, diverged: switched.diverged };
  });

  const dependenciesChanged = result.changedFiles.some((f) => DEP_MANIFESTS.includes(path.basename(f)));
  const restart = result.changedFiles.length > 0
    ? await restartPreviewIfRunning(projectId, dependenciesChanged)
    : { restarted: false, error: null };
  return {
    branch,
    changed_files: result.changedFiles.length,
    dependencies_changed: dependenciesChanged,
    diverged: result.diverged,
    preview_restarted: restart.restarted,
    preview_error: restart.error,
  };
}

/** Same restart rule as Sync: HMR doesn't cover compiled backends or new dependencies. */
async function restartPreviewIfRunning(projectId: string, dependenciesChanged: boolean): Promise<{ restarted: boolean; error: string | null }> {
  const { previewManager } = await import('@/lib/services/preview');
  if (previewManager.getStatus(projectId).status !== 'running' || isAgentRunActive(projectId)) {
    return { restarted: false, error: null };
  }
  try {
    await previewManager.stop(projectId);
    if (dependenciesChanged) await previewManager.installDependencies(projectId, { force: true });
    await previewManager.start(projectId);
    return { restarted: true, error: null };
  } catch (e) {
    return { restarted: false, error: e instanceof Error ? e.message : 'Preview restart failed' };
  }
}

/** Create `name` from the current state and switch to it (published on the next Publish). */
export async function createProjectBranch(projectId: string, name: unknown): Promise<{ branch: string }> {
  const branch = assertBranchName(name);
  assertIdle(projectId);
  const ctx = await loadCtx(projectId);
  if (ctx.remote) {
    const remote = await remoteBranchNames(ctx.remote);
    if (remote?.includes(branch)) throw branchError(`Branch "${branch}" already exists — pick it from the list to switch to it.`, 409);
  }
  await withGitLock(projectId, async () => {
    assertIdle(projectId);
    if (localBranchNames(ctx.repoPath).includes(branch)) {
      throw branchError(`Branch "${branch}" already exists — pick it from the list to switch to it.`, 409);
    }
    await rememberBase(projectId, ctx);
    const current = operatingBranch(ctx);
    commitAll(ctx.repoPath, `Work in progress on ${current}`);
    if (ctx.remote) adoptBranchName(ctx.repoPath, current);
    createLocalBranch(ctx.repoPath, branch);
    if (ctx.remote) await updateProjectServiceData(projectId, 'github', { branch });
  });
  return { branch };
}

export interface MergeOutcome {
  merged: boolean;
  branch: string;
  base: string;
  mode: 'local' | 'remote';
  message: string;
}

/**
 * Merge the current branch into the base branch. With a remote: publish the
 * branch, then merge it through a pull request (the host runs its deploy on the
 * base branch). Local-only: a local merge; the current branch stays checked out.
 */
export async function mergeProjectBranchIntoBase(projectId: string): Promise<MergeOutcome> {
  assertIdle(projectId);
  const ctx = await loadCtx(projectId);
  const branch = operatingBranch(ctx);
  const base = baseBranchOf(ctx);
  if (branch === base) throw branchError(`You are on ${base} already — switch to another branch to merge it into ${base}.`, 400);

  if (!ctx.remote) {
    const outcome = await withGitLock(projectId, async () => {
      assertIdle(projectId);
      commitAll(ctx.repoPath, `Work in progress on ${branch}`);
      try {
        return mergeLocalBranch(ctx.repoPath, branch, base);
      } catch (e) {
        throw branchError(e instanceof Error ? e.message : String(e), 409);
      }
    });
    return {
      merged: outcome === 'merged', branch, base, mode: 'local',
      message: outcome === 'merged' ? `Merged ${branch} into ${base}` : `${base} already contains everything from ${branch}`,
    };
  }

  // Publish the branch first (its own lock; the customer guard runs inside).
  await pushProjectToGitHub(projectId);
  const r = ctx.remote;
  const outcome = await withGitLock(projectId, async () => {
    if (await isCustomerProject(projectId)) {
      // What the merge brings into the base branch: this branch's side only.
      if (!fetchRemoteBranch(ctx.repoPath, base, r.authUrl)) throw branchError(`Branch "${base}" does not exist on the remote.`, 404);
      const blocked = protectedPathsIn(pathsChangedSinceMergeBase(ctx.repoPath, 'FETCH_HEAD'));
      if (blocked.length > 0) {
        throw branchError(`Merging is blocked: this branch changes deployment files that New Story manages (${blocked.join(', ')}). Undo those changes on the branch and try again.`, 403);
      }
    }
    return mergePublishPr(r.token, r.cfg, r.owner, r.repo, branch, base, `Merge ${branch} into ${base}`);
  });
  await updateProjectServiceData(projectId, 'github', { last_pushed_at: new Date().toISOString() });
  return {
    merged: outcome === 'merged', branch, base, mode: 'remote',
    message: outcome === 'merged' ? `Merged ${branch} into ${base}` : `${base} already contains everything from ${branch}`,
  };
}
