/**
 * Every project is git: the boot sweep gives each project a local repository
 * (ensureLocalGit) and links a repository the project ALREADY has on this
 * Claudable's own git server (an `origin` on the configured host) as its
 * connection, so Publish / branches work against it. A remote on any other host
 * is never touched, and no new remote repository is ever created here —
 * connecting a new one stays an explicit action in Settings.
 */
import { prisma } from '@/lib/db/client';
import { getGitProviderConfig } from '@/lib/services/git-provider';
import { githubFetch, resolveGitToken, resolveProjectRepoPath } from '@/lib/services/github';
import { getProjectService, upsertProjectServiceConnection } from '@/lib/services/project-services';
import { originUrl } from '@/lib/services/git';
import { ensureLocalGit } from '@/lib/services/git-branches';

const SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/u;

/** owner/repo of `url` when it points at `httpBase` (credentials ignored), else null. */
export function parseOwnRemote(url: string, httpBase: string): { owner: string; repo: string } | null {
  let u: URL;
  let base: URL;
  try {
    u = new URL(url);
    base = new URL(httpBase);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.host !== base.host) return null;
  const basePath = base.pathname.replace(/\/+$/u, '');
  if (basePath && !u.pathname.startsWith(`${basePath}/`)) return null;
  const parts = u.pathname.slice(basePath.length).split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/u, '');
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

export type AdoptResult = 'connected' | 'adopted' | 'no-remote' | 'foreign-remote' | 'not-found' | 'no-repo';

/** Link the project's existing own-server `origin` as its git connection. */
export async function adoptExistingRemote(projectId: string): Promise<AdoptResult> {
  const service = await getProjectService(projectId, 'github');
  if ((service?.serviceData as Record<string, unknown> | undefined)?.clone_url) return 'connected';
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { repoPath: true } });
  if (!project) return 'no-repo';
  const url = originUrl(resolveProjectRepoPath(projectId, project.repoPath));
  if (!url) return 'no-remote';
  const cfg = getGitProviderConfig();
  const own = parseOwnRemote(url, cfg.httpBase);
  if (!own) return 'foreign-remote';
  let repo: any;
  try {
    repo = await githubFetch(await resolveGitToken(), `/repos/${own.owner}/${own.repo}`);
  } catch {
    return 'not-found';
  }
  if (typeof repo?.clone_url !== 'string') return 'not-found';
  await upsertProjectServiceConnection(projectId, 'github', {
    repo_url: repo.html_url,
    repo_name: repo.name,
    clone_url: repo.clone_url,
    default_branch: repo.default_branch || 'main',
    owner: repo.owner?.login || own.owner,
  });
  return 'adopted';
}

/** Boot sweep: local git for every project with content; adopt own-server remotes. */
export async function ensureAllProjectsGit(): Promise<void> {
  const projects = await prisma.project.findMany({ select: { id: true } });
  const summary: Record<string, number> = {};
  for (const { id } of projects) {
    try {
      const local = await ensureLocalGit(id);
      const outcome = local ? await adoptExistingRemote(id) : 'no-repo';
      summary[outcome] = (summary[outcome] ?? 0) + 1;
      if (outcome === 'adopted') console.log(`[git] linked existing repository for project ${id}`);
    } catch (e) {
      summary.error = (summary.error ?? 0) + 1;
      console.warn(`[git] could not ensure git for project ${id}:`, e instanceof Error ? e.message : e);
    }
  }
  console.log('[git] every-project-is-git sweep:', JSON.stringify(summary));
}
