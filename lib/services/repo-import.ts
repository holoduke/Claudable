import fs from 'fs/promises';
import path from 'path';
import { getPlainServiceToken } from '@/lib/services/tokens';
import { createProject, updateProject, deleteProject } from '@/lib/services/project';
import { upsertProjectServiceConnection } from '@/lib/services/project-services';
import { cloneRepository, getCurrentBranch, addOrUpdateRemote } from '@/lib/services/git';
import { generateProjectId } from '@/lib/utils';
import { getDefaultModelForCli, normalizeModelId } from '@/lib/constants/cliModels';
import type { Project } from '@/types/backend';

export interface ParsedGitHubRepositoryUrl {
  owner: string;
  repo: string;
  branch: string | null;
}

export interface BuildGitHubCloneUrlsInput {
  owner: string;
  repo: string;
  token?: string | null;
}

export interface GitHubCloneUrls {
  cleanUrl: string;
  authenticatedUrl: string | null;
}

export interface BuildGitCloneArgsInput {
  remoteUrl: string;
  targetPath: string;
  branch?: string | null;
}

export interface ImportGitHubRepositoryInput {
  repoUrl: string;
  branch?: string | null;
  projectId?: string | null;
  name?: string | null;
  description?: string | null;
  preferredCli?: string | null;
  selectedModel?: string | null;
}

const GITHUB_HOST = 'github.com';

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, '');
}

function assertRepositoryParts(owner: string | undefined, repo: string | undefined): asserts owner is string {
  if (!owner || !repo) {
    throw new Error('GitHub repository URL must include owner and repository name');
  }
}

function assertRepoName(repo: string | undefined): asserts repo is string {
  if (!repo) {
    throw new Error('GitHub repository URL must include owner and repository name');
  }
}

function normalizeRepoName(repo: string): string {
  return stripGitSuffix(repo.replace(/\/+$/g, ''));
}

export function parseGitHubRepositoryUrl(input: string): ParsedGitHubRepositoryUrl {
  const raw = input.trim();
  if (!raw) {
    throw new Error('GitHub repository URL is required');
  }

  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    const owner = sshMatch[1];
    const repo = normalizeRepoName(sshMatch[2]);
    assertRepositoryParts(owner, repo);
    return { owner, repo, branch: null };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid GitHub repository URL');
  }

  if (url.hostname.toLowerCase() !== GITHUB_HOST) {
    throw new Error('Only github.com repositories are supported');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const owner = segments[0];
  const repo = segments[1] ? normalizeRepoName(segments[1]) : undefined;
  assertRepositoryParts(owner, repo);
  assertRepoName(repo);

  let branch: string | null = null;
  const treeIndex = segments.findIndex((segment) => segment === 'tree');
  if (treeIndex >= 0 && segments.length > treeIndex + 1) {
    branch = segments.slice(treeIndex + 1).join('/');
  }

  return { owner, repo, branch };
}

export function buildGitHubCloneUrls(input: BuildGitHubCloneUrlsInput): GitHubCloneUrls {
  const cleanUrl = `https://github.com/${input.owner}/${input.repo}.git`;
  const token = input.token?.trim();

  return {
    cleanUrl,
    authenticatedUrl: token
      ? `https://x-access-token:${encodeURIComponent(token)}@github.com/${input.owner}/${input.repo}.git`
      : null,
  };
}

export function buildGitCloneArgs(input: BuildGitCloneArgsInput): string[] {
  const branch = input.branch?.trim();
  if (!branch) {
    return ['clone', input.remoteUrl, input.targetPath];
  }

  return [
    'clone',
    '--branch',
    branch,
    '--single-branch',
    input.remoteUrl,
    input.targetPath,
  ];
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(process.cwd(), PROJECTS_DIR);

async function assertTargetDoesNotExist(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
    throw new Error('Project import target already exists');
  } catch (error) {
    if (error instanceof Error && error.message === 'Project import target already exists') {
      throw error;
    }
  }
}

export async function importGitHubRepository(input: ImportGitHubRepositoryInput): Promise<Project> {
  const parsed = parseGitHubRepositoryUrl(input.repoUrl);
  const branch = input.branch?.trim() || parsed.branch;
  const projectId = input.projectId?.trim() || generateProjectId();
  const projectName = input.name?.trim() || parsed.repo;
  const preferredCli = (input.preferredCli?.trim() || 'claude').toLowerCase();
  const selectedModel = normalizeModelId(
    preferredCli,
    input.selectedModel ?? getDefaultModelForCli(preferredCli),
  );

  const targetPath = path.join(PROJECTS_DIR_ABSOLUTE, projectId);
  await assertTargetDoesNotExist(targetPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const token = await getPlainServiceToken('github').catch(() => null);
  const cloneUrls = buildGitHubCloneUrls({
    owner: parsed.owner,
    repo: parsed.repo,
    token,
  });
  const cloneUrl = cloneUrls.authenticatedUrl ?? cloneUrls.cleanUrl;

  try {
    await cloneRepository({
      remoteUrl: cloneUrl,
      targetPath,
      branch,
    });

    addOrUpdateRemote(targetPath, 'origin', cloneUrls.cleanUrl);
    const defaultBranch = getCurrentBranch(targetPath) || branch || 'main';

    const project = await createProject({
      project_id: projectId,
      name: projectName,
      description: input.description ?? `Imported from ${parsed.owner}/${parsed.repo}`,
      initialPrompt: '',
      preferredCli,
      selectedModel,
    });

    try {
      const updated = await updateProject(project.id, {
        repoPath: targetPath,
        status: 'idle',
      });

      await upsertProjectServiceConnection(project.id, 'github', {
        repo_url: `https://github.com/${parsed.owner}/${parsed.repo}`,
        repo_name: parsed.repo,
        clone_url: cloneUrls.cleanUrl,
        default_branch: defaultBranch,
        owner: parsed.owner,
        imported_at: new Date().toISOString(),
      });

      return updated;
    } catch (error) {
      await deleteProject(project.id).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
