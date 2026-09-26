/**
 * Completely wipe ONE project — and nothing else.
 *
 * A project owns resources in many places (DB rows, its repo dir, side-car dirs,
 * preview/agent/sidecar containers, managed-service containers + volumes, its
 * docker network, Traefik route files, thumbnails, design-explorer scratch, and
 * optionally an external Coolify database and its remote git repo). This module
 * first builds a PLAN (shown to the user) and then executes exactly that plan.
 *
 * Isolation rules — the whole point is that no other project is ever touched:
 *  - Filesystem: every path must resolve (realpath) STRICTLY INSIDE its own base
 *    dir, must be derived from this project's id, and must not equal / contain /
 *    be contained in another project's repoPath. Symlinked roots are unlinked,
 *    never followed.
 *  - Docker / Traefik: only EXACT names (never `--filter name=` prefix matches).
 *    Names are derived from previewSlug(id); if ANY other project derives the same
 *    name (slug collisions such as `Foo`/`foo`, or `x`'s backend vs `x-api`'s
 *    frontend), that resource is skipped and reported instead of removed.
 *  - External (Coolify DB, git repo): opt-in, and only when no other project's
 *    service connection references the same database / repository. The repo must
 *    live in the org Claudable manages (GIT_ORG) on Gitea.
 *  - Nothing shared is removed: org, users, credentials, plugins, npm cache,
 *    credits/usage ledger and the audit trail stay.
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/db/client';
import { previewSlug } from './preview/routes';

// ---------------------------------------------------------------------------
// Paths (same derivations as the code that creates them)
// ---------------------------------------------------------------------------

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_ROOT = path.isAbsolute(PROJECTS_DIR) ? PROJECTS_DIR : path.resolve(process.cwd(), PROJECTS_DIR);
const DATA_ROOT = path.resolve(PROJECTS_ROOT, '..');
const AGENT_HOMES_ROOT = path.resolve(process.cwd(), 'data', 'agent-homes'); // cli/claude.ts
const CHECKPOINTS_ROOT = path.resolve(PROJECTS_ROOT, '..', 'checkpoints'); // checkpoints.ts
const THUMBS_ROOT = path.isAbsolute(process.env.THUMBNAILS_DIR || '') // thumbnail.ts
  ? (process.env.THUMBNAILS_DIR as string)
  : path.resolve(process.cwd(), process.env.THUMBNAILS_DIR || 'data/thumbnails');

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// In-progress guard: preview/agent starts refuse a project that is being wiped
// ---------------------------------------------------------------------------

const wiping = new Set<string>();
export function isWiping(projectId: string): boolean {
  return wiping.has(projectId);
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/** True if `target` is strictly inside `base` (not equal to it). Both must be absolute. */
export function isStrictlyInside(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Every docker / Traefik name a project derives from its id. */
export function projectRuntimeNames(projectId: string) {
  const slug = previewSlug(projectId);
  return {
    slug,
    frontendContainer: `claudable-preview-${slug}`,
    backendContainer: `claudable-preview-${slug}-api`,
    network: `claudable-proj-${slug}`,
    routeFiles: [`preview-${slug}.yml`, `preview-${slug}-api.yml`],
    agentContainerRe: new RegExp(`^claudable-agent-${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{8}$`),
  };
}

/** Names of `projectId` that another project ALSO derives — these must not be removed. */
export function sharedRuntimeNames(projectId: string, otherProjectIds: string[]): Set<string> {
  const mine = projectRuntimeNames(projectId);
  const mineList = [mine.frontendContainer, mine.backendContainer, mine.network, ...mine.routeFiles];
  const theirs = new Set<string>();
  for (const other of otherProjectIds) {
    if (other === projectId) continue;
    const n = projectRuntimeNames(other);
    for (const x of [n.frontendContainer, n.backendContainer, n.network, ...n.routeFiles]) theirs.add(x);
  }
  return new Set(mineList.filter((x) => theirs.has(x)));
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface WipeOptions {
  /** Also delete the project's external Coolify database (all its data). */
  deleteDatabase?: boolean;
  /** Also delete the project's remote git repository (Gitea, org-managed repos only). */
  deleteRemoteRepo?: boolean;
}

export interface WipePlan {
  project: { id: string; name: string };
  paths: string[];
  containers: string[];
  agentContainerPattern: string;
  network: string | null;
  routeFiles: string[];
  managedServices: { container: string; volume: string }[];
  database: { uuid: string; name?: string; deletable: boolean; reason?: string } | null;
  remoteRepo: { owner: string; repo: string; url?: string; deletable: boolean; reason?: string } | null;
  /** Things that are deliberately NOT removed, with the reason. */
  skipped: { what: string; reason: string }[];
  /** Hard blockers: the wipe refuses to run while any exist. */
  blockers: string[];
}

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(() => true, () => false);
}

export async function planWipe(projectId: string): Promise<WipePlan> {
  if (!PROJECT_ID_RE.test(projectId)) throw new Error('Invalid project id');
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error('Project not found');

  const others = await prisma.project.findMany({
    where: { id: { not: projectId } },
    select: { id: true, repoPath: true },
  });
  const skipped: WipePlan['skipped'] = [];
  const blockers: string[] = [];

  // --- filesystem ---------------------------------------------------------
  const paths: string[] = [];
  const projectsRootReal = (await realOrNull(PROJECTS_ROOT)) || PROJECTS_ROOT;
  const otherRepoPaths = others
    .map((o) => o.repoPath)
    .filter((p): p is string => !!p)
    .map((p) => path.resolve(p));

  if (project.repoPath) {
    const repo = path.resolve(project.repoPath);
    const repoReal = (await realOrNull(repo)) || repo;
    const overlaps = otherRepoPaths.some((o) => o === repo || isStrictlyInside(repo, o) || isStrictlyInside(o, repo));
    if (!isStrictlyInside(PROJECTS_ROOT, repo) || !isStrictlyInside(projectsRootReal, repoReal)) {
      skipped.push({ what: `project folder ${repo}`, reason: 'outside the projects directory — left untouched' });
    } else if (overlaps) {
      skipped.push({ what: `project folder ${repo}`, reason: 'shared with (or nested in) another project — left untouched' });
    } else if (await exists(repo)) {
      paths.push(repo);
    }
  }
  const sideCars: [string, string][] = [
    [AGENT_HOMES_ROOT, path.join(AGENT_HOMES_ROOT, projectId)],
    [CHECKPOINTS_ROOT, path.join(CHECKPOINTS_ROOT, projectId)],
    [THUMBS_ROOT, path.join(THUMBS_ROOT, `${projectId}.webp`)],
    [THUMBS_ROOT, path.join(THUMBS_ROOT, `${projectId}.png`)],
  ];
  const canvases = await prisma.designCanvas.findMany({ where: { projectId }, select: { id: true } }).catch(() => []);
  const canvasRoot = path.resolve(process.cwd(), 'data', 'design-canvases');
  for (const c of canvases) {
    if (/^[a-z0-9]+$/i.test(c.id)) sideCars.push([canvasRoot, path.join(canvasRoot, c.id)]);
  }
  for (const [base, p] of sideCars) {
    if (isStrictlyInside(base, p) && (await exists(p))) paths.push(p);
  }

  // --- docker / traefik ----------------------------------------------------
  const names = projectRuntimeNames(projectId);
  const shared = sharedRuntimeNames(projectId, others.map((o) => o.id));
  const keep = (n: string) => {
    if (!shared.has(n)) return true;
    skipped.push({ what: n, reason: 'another project uses the same name — left untouched' });
    return false;
  };
  const containers = [names.frontendContainer, names.backendContainer].filter(keep);
  const network = keep(names.network) ? names.network : null;
  const routeFiles = names.routeFiles.filter(keep);

  // managed services (DB/cache containers): exact names, collision-checked
  const managedServices: WipePlan['managedServices'] = [];
  try {
    const { getServices } = await import('./managed-containers');
    const mineSpecs = await getServices(projectId);
    const otherNames = new Set<string>();
    for (const o of others) {
      for (const s of await getServices(o.id).catch(() => [])) {
        otherNames.add(`claudable-svc-${previewSlug(o.id)}-${s.id}`);
      }
    }
    for (const s of mineSpecs) {
      const container = `claudable-svc-${names.slug}-${s.id}`;
      if (otherNames.has(container)) {
        skipped.push({ what: container, reason: 'another project uses the same name — left untouched' });
      } else {
        managedServices.push({ container, volume: `${container}-data` });
      }
    }
  } catch { /* no managed containers configured */ }

  // --- external -----------------------------------------------------------
  const connections = await prisma.projectServiceConnection.findMany({ where: { projectId } });
  const dbConn = connections.find((c) => c.provider === 'database');
  let database: WipePlan['database'] = null;
  if (dbConn) {
    const data = safeJson(dbConn.serviceData);
    const uuid = typeof data.coolifyUuid === 'string' ? data.coolifyUuid : '';
    if (uuid) {
      const sharedDb = (await prisma.projectServiceConnection.findMany({
        where: { provider: 'database', projectId: { not: projectId } },
        select: { serviceData: true },
      })).filter((c) => safeJson(c.serviceData).coolifyUuid === uuid).length;
      database = sharedDb
        ? { uuid, name: data.database, deletable: false, reason: 'also used by another project' }
        : { uuid, name: data.database, deletable: true };
    }
  }

  const gitConn = connections.find((c) => c.provider === 'github');
  let remoteRepo: WipePlan['remoteRepo'] = null;
  if (gitConn) {
    const data = safeJson(gitConn.serviceData);
    const owner = String(data.owner || '');
    const repo = String(data.repo_name || '');
    if (owner && repo) {
      const { getGitProviderConfigFor, getGitProviderConfig } = await import('./git-provider');
      const cfg = getGitProviderConfigFor(data);
      const managedOrg = getGitProviderConfig().org;
      const otherUses = (await prisma.projectServiceConnection.findMany({
        where: { provider: 'github', projectId: { not: projectId } },
        select: { serviceData: true },
      })).filter((c) => {
        const d = safeJson(c.serviceData);
        return String(d.owner || '').toLowerCase() === owner.toLowerCase()
          && String(d.repo_name || '').toLowerCase() === repo.toLowerCase();
      }).length;
      let reason: string | undefined;
      if (cfg.provider !== 'gitea') reason = 'only Gitea repositories can be deleted from here';
      else if (!managedOrg || owner.toLowerCase() !== managedOrg.toLowerCase()) reason = `repository is not in the managed org (${managedOrg || 'none'})`;
      else if (!/^[A-Za-z0-9._-]+$/.test(repo)) reason = 'unexpected repository name';
      else if (otherUses) reason = 'also linked to another project';
      remoteRepo = { owner, repo, url: typeof data.repo_url === 'string' ? data.repo_url : undefined, deletable: !reason, reason };
      skipped.push({
        what: `live deployment of ${owner}/${repo} (if published)`,
        reason: 'a published site keeps running; remove it separately (it may be production)',
      });
    }
  }

  if (wiping.has(projectId)) blockers.push('A wipe of this project is already running.');

  return {
    project: { id: project.id, name: project.name },
    paths,
    containers,
    agentContainerPattern: names.agentContainerRe.source,
    network,
    routeFiles,
    managedServices,
    database,
    remoteRepo,
    skipped,
    blockers,
  };
}

function safeJson(v: unknown): Record<string, any> {
  if (v && typeof v === 'object') return v as Record<string, any>;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

function docker(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    try {
      const p = spawn('docker', args, { env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const t = setTimeout(() => { p.kill('SIGKILL'); resolve({ ok: false, out }); }, 30_000);
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => { clearTimeout(t); resolve({ ok: false, out }); });
      p.on('exit', (code) => { clearTimeout(t); resolve({ ok: code === 0, out }); });
    } catch {
      resolve({ ok: false, out: '' });
    }
  });
}

export interface WipeReport {
  plan: WipePlan;
  removed: string[];
  failed: { what: string; error: string }[];
}

export async function wipeProject(
  projectId: string,
  opts: WipeOptions = {},
  actor?: { id?: string | null; email?: string | null } | null,
): Promise<WipeReport> {
  const plan = await planWipe(projectId);
  if (plan.blockers.length) throw new Error(plan.blockers.join(' '));
  wiping.add(projectId);
  const removed: string[] = [];
  const failed: WipeReport['failed'] = [];
  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      removed.push(what);
    } catch (e) {
      failed.push({ what, error: e instanceof Error ? e.message : String(e) });
    }
  };

  try {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { orgId: true, name: true } });

    // 1. stop a running agent turn and the preview (in-memory state + processes)
    try {
      const { interruptAgentRun } = await import('./cli/run-registry');
      interruptAgentRun(projectId);
    } catch { /* no agent running */ }
    const { previewManager } = await import('./preview');
    if (plan.routeFiles.length === 2 && plan.containers.length === 2) {
      // stop() removes this project's route files + containers — only safe without name collisions
      await previewManager.stop(projectId).catch(() => {});
    } else if (previewManager.getStatus(projectId).status === 'running') {
      throw new Error('Stop this project’s preview first (it shares runtime names with another project).');
    }

    // 2. containers/volumes/network by EXACT name (also covers orphans left by an app restart).
    //    Listed first so only resources that really exist are touched and reported.
    const list = async (args: string[]) =>
      new Set((await docker(args)).out.split('\n').map((x) => x.trim()).filter(Boolean));
    const existingContainers = await list(['ps', '-a', '--format', '{{.Names}}']);
    const existingVolumes = await list(['volume', 'ls', '--format', '{{.Name}}']);
    const existingNetworks = await list(['network', 'ls', '--format', '{{.Name}}']);
    const rm = (kind: string, name: string, args: string[]) =>
      attempt(`${kind} ${name}`, async () => {
        const r = await docker(args);
        if (!r.ok) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed`);
      });
    const agentRe = new RegExp(plan.agentContainerPattern);
    const containers = [...plan.containers, ...plan.managedServices.map((s) => s.container)]
      .filter((n) => existingContainers.has(n));
    for (const n of existingContainers) if (agentRe.test(n)) containers.push(n);
    for (const n of containers) await rm('container', n, ['rm', '-f', n]);
    for (const s of plan.managedServices) {
      if (existingVolumes.has(s.volume)) await rm('volume', s.volume, ['volume', 'rm', '-f', s.volume]);
    }
    if (plan.network && existingNetworks.has(plan.network)) {
      await rm('network', plan.network, ['network', 'rm', plan.network]);
    }

    // 3. Traefik route files (only ours, collision-checked in the plan)
    const routeDir = process.env.TRAEFIK_DYNAMIC_DIR?.trim();
    if (routeDir) {
      for (const f of plan.routeFiles) {
        const p = path.join(routeDir, f);
        if (isStrictlyInside(routeDir, p) && (await exists(p))) {
          const head = (await fs.readFile(p, 'utf8').catch(() => '')).split('\n', 1)[0];
          if (head === '# claudable-managed-preview') await attempt(`route ${f}`, () => fs.unlink(p));
        }
      }
    }

    // 4. external resources (opt-in, never shared)
    if (opts.deleteDatabase && plan.database?.deletable) {
      await attempt(`database ${plan.database.name || plan.database.uuid}`, async () => {
        const { removeDatabase } = await import('./database');
        await removeDatabase(projectId);
      });
    }
    if (opts.deleteRemoteRepo && plan.remoteRepo?.deletable) {
      const { owner, repo } = plan.remoteRepo;
      await attempt(`repository ${owner}/${repo}`, async () => {
        const { deleteRepo } = await import('./itops/gitea-admin-ops');
        await deleteRepo(repo, owner);
      });
    }

    // 5. filesystem — re-validate right before deleting (TOCTOU), never follow a symlinked root
    for (const p of plan.paths) {
      await attempt(`folder ${path.relative(DATA_ROOT, p) || p}`, async () => {
        const st = await fs.lstat(p).catch(() => null);
        if (!st) return;
        if (st.isSymbolicLink()) {
          await fs.unlink(p);
          return;
        }
        await fs.rm(p, { recursive: true, force: true });
      });
    }

    // 6. database rows (cascades messages, sessions, env vars, members, shares, …).
    //    Kept on purpose: the credits/usage ledger and the audit trail.
    await prisma.project.delete({ where: { id: projectId } });
    removed.push('project record (chats, sessions, env vars, members, shares, comments, design canvases)');

    const { recordAudit } = await import('./audit');
    await recordAudit({
      orgId: project?.orgId ?? null,
      actor: actor ?? null,
      action: 'project.deleted',
      targetType: 'project',
      targetId: projectId,
      meta: {
        name: project?.name,
        deleteDatabase: !!opts.deleteDatabase,
        deleteRemoteRepo: !!opts.deleteRemoteRepo,
        removedCount: removed.length,
        failed: failed.map((f) => f.what),
        skipped: plan.skipped.map((s) => s.what),
      },
    });
    console.log(`[wipe] ${projectId}: removed ${removed.length}, failed ${failed.length}, skipped ${plan.skipped.length}`);
    return { plan, removed, failed };
  } finally {
    wiping.delete(projectId);
  }
}
