/**
 * PreviewManager - Handles per-project development servers (live preview)
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { findAvailablePort } from '@/lib/utils/ports';
import { getProjectById, updateProject, updateProjectStatus } from './project';
import { prisma } from '@/lib/db/client';
import { ensureServicesRunning } from '@/lib/services/managed-containers';
import { recordBackendChunk } from '@/lib/services/diagnostics';
import { scaffoldForStack } from '@/lib/utils/scaffold-dispatch';
import { stackKind } from '@/lib/config/stacks';
import { PREVIEW_CONFIG } from '@/lib/config/constants';
import {
  previewRouteDir,
  previewUrlFor,
  previewSlug,
  removePreviewRoute,
  removeBackendRoute,
  sweepPreviewRoutes,
} from './preview/routes';
import {
  sweepOrphanedPreviewContainers,
  isolationEnabled,
  backendContainerName,
  removeBackendContainer,
  removeProjectNetwork,
  ensureProjectNetwork,
  connectToProjectNet,
  latestMtimeMs,
} from './preview/docker';
import { killProcessTree, appendCommandLogs } from './preview/process-utils';
import {
  npmCommand,
  directoryExists,
  runInstallWithPreferredManager,
  ensureProjectRootStructure,
  readPackageJson,
} from './preview/scaffold';
import { writeArchitectureSummary } from './preview/architecture';
import { readPreviewConfig, resolvePreviewBounds } from './preview/config';
import {
  resolveProjectWorkspace,
  buildBaseSpawnEnv,
  applyEnvOverrides,
  publishPreviewRouteAndWarmCert,
  buildDevServerArgs,
  startComposedBackend,
  startStaticServer,
  buildFrontendContainerArgs,
  buildScrubbedEnv,
  awaitReadinessAndFinalize,
} from './preview/start-phases';
import type { PreviewProcess, PreviewInfo } from './preview/types';

// Re-export the public preview API so existing importers keep working unchanged.
export { previewSlug, projectPreviewUrl } from './preview/routes';
export {
  ensureProjectNetwork,
  removeProjectNetwork,
} from './preview/docker';
export type { PreviewInfo } from './preview/types';

/**
 * Clear persisted preview URLs/ports for ALL projects. Called once on boot: after
 * a restart the in-memory process map is empty and every dev server is dead, so a
 * cached previewUrl/previewPort is stale and — since ports get reused across
 * projects — could otherwise point a project at another project's preview.
 */
async function clearAllPreviewState(): Promise<void> {
  try {
    await prisma.project.updateMany({
      where: { OR: [{ previewUrl: { not: null } }, { previewPort: { not: null } }] },
      data: { previewUrl: null, previewPort: null },
    });
  } catch {
    /* non-fatal: the frontend uses live status, this is defense-in-depth */
  }
}

const LOG_LIMIT = PREVIEW_CONFIG.LOG_LIMIT;

// Idle previews are evicted so the small port pool (e.g. 3710-3719) can't be
// permanently exhausted by dev servers from closed/crashed tabs. An open chat
// page heartbeats /preview/status, which keeps its preview warm.
const PREVIEW_IDLE_TIMEOUT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.PREVIEW_IDLE_TIMEOUT_MS || '', 10) || 20 * 60_000,
);
const PREVIEW_SWEEP_INTERVAL_MS = Math.max(
  10_000,
  Number.parseInt(process.env.PREVIEW_SWEEP_INTERVAL_MS || '', 10) || 5 * 60_000,
);

class PreviewManager {
  private processes = new Map<string, PreviewProcess>();
  private installing = new Map<string, Promise<void>>();
  // Serializes concurrent start() calls for the same project so two callers
  // can't both pass the "not running" check and spawn duplicate dev servers,
  // which would exhaust the preview port range and orphan processes.
  private starting = new Map<string, Promise<PreviewInfo>>();
  // Ports picked but whose dev server hasn't bound yet. Reserved atomically so two
  // concurrent starts can't land on the same port (a cross-project preview leak).
  private reservedPorts = new Set<number>();
  private reservedByProject = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Periodically reclaim ports held by previews nobody is watching anymore.
    this.sweepTimer = setInterval(() => this.evictIdle(), PREVIEW_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
    // On boot the process map is empty but the DB may hold previewUrl/previewPort
    // from before a restart — those servers are dead and their ports may be reused
    // by OTHER projects, so a stale URL could point at the wrong project. Clear them
    // and remove all stale per-project preview routes (dev servers are all dead).
    void clearAllPreviewState();
    void sweepPreviewRoutes();
    void sweepOrphanedPreviewContainers(); // free ports held by containers from before the restart
  }

  /** Ports currently held (live processes) or reserved in-flight. */
  private usedPorts(): Set<number> {
    const s = new Set<number>(this.reservedPorts);
    for (const p of this.processes.values()) if (typeof p.port === 'number') s.add(p.port);
    return s;
  }

  /** Stop previews that haven't been accessed within the idle window. */
  private evictIdle(): void {
    const now = Date.now();
    for (const [projectId, p] of this.processes) {
      if (p.status === 'starting') continue;
      if (now - p.lastAccessedAt.getTime() > PREVIEW_IDLE_TIMEOUT_MS) {
        const idleMin = Math.round((now - p.lastAccessedAt.getTime()) / 60_000);
        console.log(`[PreviewManager] Evicting idle preview ${projectId} (idle ${idleMin}m, port ${p.port})`);
        this.stop(projectId).catch(() => {});
      }
    }
  }

  /** The least-recently-accessed running preview (for eviction when the pool is full). */
  private leastRecentlyUsed(): string | null {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [projectId, p] of this.processes) {
      if (p.status === 'starting') continue;
      const t = p.lastAccessedAt.getTime();
      if (t < oldestTime) {
        oldestTime = t;
        oldest = projectId;
      }
    }
    return oldest;
  }

  private getLogger(processInfo: PreviewProcess) {
    return (chunk: Buffer | string) => {
      const lines = chunk
        .toString()
        .split(/\r?\n/)
        .filter((line) => line.trim().length);
      lines.forEach((line) => {
        processInfo.logs.push(line);
        if (processInfo.logs.length > LOG_LIMIT) {
          processInfo.logs.shift();
        }
      });
    };
  }

  public async installDependencies(projectId: string): Promise<{ logs: string[] }> {
    const project = await getProjectById(projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    // Static imports have no npm deps and are never scaffolded. Laravel is PHP —
    // composer install happens in the preview container's bootstrap, not here.
    const kind = stackKind(project.templateType);
    if (kind === 'static' || kind === 'laravel') {
      return { logs: [`[PreviewManager] ${kind} project — no npm dependencies to install here`] };
    }

    const projectPath = project.repoPath
      ? path.resolve(project.repoPath)
      : path.join(process.cwd(), 'projects', projectId);

    await fs.mkdir(projectPath, { recursive: true });

    const logs: string[] = [];
    const record = (message: string) => {
      const formatted = `[PreviewManager] ${message}`;
      console.log(formatted);
      logs.push(formatted);
    };

    await ensureProjectRootStructure(projectPath, record, kind);

    try {
      await fs.access(path.join(projectPath, 'package.json'));
    } catch {
      const proj = await getProjectById(projectId).catch(() => null);
      record(`Bootstrapping ${stackKind(proj?.templateType)} app for project ${projectId}`);
      await scaffoldForStack(projectPath, projectId, proj?.templateType, proj?.name);
    }

    const hadNodeModules = await directoryExists(path.join(projectPath, 'node_modules'));

    const collectFromChunk = (chunk: Buffer | string) => {
      chunk
        .toString()
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .forEach((line) => record(line));
    };

    // Use a per-project lock to avoid concurrent install commands
    const runInstall = async () => {
      const installPromise = (async () => {
        try {
          const hasNodeModules = await directoryExists(path.join(projectPath, 'node_modules'));
          if (!hasNodeModules) {
            await runInstallWithPreferredManager(
              projectPath,
              { ...process.env },
              collectFromChunk
            );
          }
        } finally {
          this.installing.delete(projectId);
        }
      })();
      this.installing.set(projectId, installPromise);
      await installPromise;
    };

    // If an install is already in progress, wait for it; otherwise start one
    const existing = this.installing.get(projectId);
    if (existing) {
      record('Dependency installation already in progress; waiting for completion.');
      await existing;
    } else {
      await runInstall();
    }

    if (hadNodeModules) {
      record('Dependencies already installed. Skipped install command.');
    } else {
      record('Dependency installation completed.');
    }

    return { logs };
  }

  /**
   * The project's public preview URL WITHOUT waiting for the dev server to boot.
   * Only meaningful for the per-project-subdomain setup (PREVIEW_URL_TEMPLATE with
   * `{project}`), where the URL is deterministic and port-independent — so a
   * caller can return it immediately and warm the server in the background,
   * instead of blocking ~20-30s on a cold start. Returns null when the URL
   * depends on the assigned port (must start first to know it).
   */
  public deterministicPreviewUrl(projectId: string): string | null {
    const running = this.processes.get(projectId);
    if (running?.url) return running.url;
    const tmpl = process.env.PREVIEW_URL_TEMPLATE || '';
    if (tmpl.includes('{project}') && previewRouteDir()) return previewUrlFor(projectId, 0);
    return null;
  }

  public async start(projectId: string): Promise<PreviewInfo> {
    const existing = this.processes.get(projectId);
    if (existing && existing.status !== 'error') {
      existing.lastAccessedAt = new Date();
      return this.toInfo(existing);
    }

    // Coalesce concurrent starts: if one is already in flight, await it
    // instead of spawning a second dev server.
    const inFlight = this.starting.get(projectId);
    if (inFlight) {
      return inFlight;
    }

    const startPromise = this.startInternal(projectId).finally(() => {
      this.starting.delete(projectId);
      // Always release any in-flight port reservation (success or failure) so a
      // failed start can't permanently shrink the port pool.
      const rp = this.reservedByProject.get(projectId);
      if (rp !== undefined) { this.reservedPorts.delete(rp); this.reservedByProject.delete(projectId); }
    });
    this.starting.set(projectId, startPromise);
    return startPromise;
  }

  /** Pick a free preview port and reserve it atomically against concurrent starts. */
  private async reservePreviewPort(
    projectId: string
  ): Promise<{ previewBounds: { start: number; end: number }; preferredPort: number }> {
    const previewBounds = resolvePreviewBounds();
    let preferredPort: number;
    try {
      // Exclude ports held by other live/starting previews so a concurrent start
      // can't pick the same one before this project's dev server binds.
      preferredPort = await findAvailablePort(previewBounds.start, previewBounds.end, this.usedPorts());
    } catch (poolFull) {
      // Pool exhausted — evict the least-recently-used preview to free a port,
      // then try once more.
      const victim = this.leastRecentlyUsed();
      if (!victim || victim === projectId) throw poolFull;
      console.log(`[PreviewManager] Port pool full; evicting LRU preview ${victim} to make room for ${projectId}`);
      await this.stop(victim).catch(() => {});
      preferredPort = await findAvailablePort(previewBounds.start, previewBounds.end, this.usedPorts());
    }
    // Guard the async gap: another concurrent start (different project) may have
    // reserved this port while findAvailablePort was probing. This check and the
    // reservation below are synchronous, so nothing can interleave between them.
    if (this.usedPorts().has(preferredPort)) {
      throw new Error(`Preview port ${preferredPort} was just claimed by another start; please retry.`);
    }
    // Reserve immediately (before the async spawn) so it's excluded from any
    // concurrent start until this project's process is registered below. Tracked
    // per-project so start()'s finally always releases it (success or failure).
    this.reservedPorts.add(preferredPort);
    this.reservedByProject.set(projectId, preferredPort);
    return { previewBounds, preferredPort };
  }

  /** Ensure dependencies with the same per-project lock used by installDependencies. */
  private async ensureDependenciesWithLock(
    projectId: string,
    projectPath: string,
    env: NodeJS.ProcessEnv,
    log: (chunk: Buffer | string) => void
  ): Promise<void> {
    // If node_modules exists, skip
    if (await directoryExists(path.join(projectPath, 'node_modules'))) {
      return;
    }
    const existing = this.installing.get(projectId);
    if (existing) {
      log(Buffer.from('[PreviewManager] Dependency installation already in progress; waiting...'));
      await existing;
      return;
    }
    const installPromise = (async () => {
      try {
        // Double-check just before install
        if (!(await directoryExists(path.join(projectPath, 'node_modules')))) {
          await runInstallWithPreferredManager(projectPath, env, log);
        }
      } finally {
        this.installing.delete(projectId);
      }
    })();
    this.installing.set(projectId, installPromise);
    await installPromise;
  }

  /** Wire the dev-server child's stdout/stderr/exit/error handlers (teardown owners once committed). */
  private attachChildHandlers(
    child: ChildProcess,
    projectId: string,
    previewProcess: PreviewProcess,
    log: (chunk: Buffer | string) => void
  ): void {
    child.stdout?.on('data', (chunk) => {
      log(chunk);
      try { recordBackendChunk(projectId, chunk, 'stdout'); } catch { /* diagnostics are best-effort */ }
      if (previewProcess.status === 'starting') {
        previewProcess.status = 'running';
      }
    });

    child.stderr?.on('data', (chunk) => {
      log(chunk);
      try { recordBackendChunk(projectId, chunk, 'stderr'); } catch { /* diagnostics are best-effort */ }
    });

    child.on('exit', (code, signal) => {
      previewProcess.status = code === 0 ? 'stopped' : 'error';
      // Tear down the backend sidecar too — it must not outlive the frontend.
      killProcessTree(previewProcess.backendProcess);
      removeBackendContainer(previewProcess.backendContainer);
      removeBackendContainer(previewProcess.frontendContainer);
      previewProcess.frontendEnvFileCleanup?.();
      void removeProjectNetwork(projectId); // Phase 1: drop the per-project net
      previewProcess.backendProcess = null;
      previewProcess.backendContainer = null;
      previewProcess.frontendContainer = null;
      previewProcess.frontendEnvFileCleanup = null;
      this.processes.delete(projectId);
      // Withdraw the per-project route — a crash must not leave it pointing at a
      // now-dead port that another project can reuse (the cross-project leak).
      void removePreviewRoute(projectId).catch(() => {});
      void removeBackendRoute(projectId).catch(() => {});
      updateProject(projectId, {
        previewUrl: null,
        previewPort: null,
      }).catch((error) => {
        console.error('[PreviewManager] Failed to reset project preview:', error);
      });
      updateProjectStatus(projectId, 'idle').catch((error) => {
        console.error('[PreviewManager] Failed to reset project status:', error);
      });
      log(
        Buffer.from(
          `Preview process exited (code: ${code ?? 'null'}, signal: ${
            signal ?? 'null'
          })`
        )
      );
    });

    child.on('error', (error) => {
      previewProcess.status = 'error';
      // Drop the dead entry so a subsequent start() isn't blocked by the
      // "already running" check at the top of start().
      killProcessTree(previewProcess.backendProcess);
      removeBackendContainer(previewProcess.backendContainer);
      removeBackendContainer(previewProcess.frontendContainer);
      previewProcess.frontendEnvFileCleanup?.();
      void removeProjectNetwork(projectId); // Phase 1: drop the per-project net
      previewProcess.backendProcess = null;
      previewProcess.backendContainer = null;
      previewProcess.frontendContainer = null;
      previewProcess.frontendEnvFileCleanup = null;
      if (this.processes.get(projectId) === previewProcess) {
        this.processes.delete(projectId);
      }
      void removePreviewRoute(projectId).catch(() => {});
      void removeBackendRoute(projectId).catch(() => {});
      log(Buffer.from(`Preview process failed: ${error.message}`));
    });
  }

  private async startInternal(projectId: string): Promise<PreviewInfo> {
    const { project, projectPath, isStatic, pendingLogs, queueLog } =
      await resolveProjectWorkspace(projectId);

    // Laravel/Filament is PHP: it has no npm deps and runs its own bootstrap
    // (composer + artisan) inside the preview container — treat it like `static`
    // for the node install/scaffold gates below, and require the containerized
    // path (there's no PHP toolchain in the app process for an in-process run).
    const feKind = stackKind(project.templateType);
    const isLaravel = feKind === 'laravel';
    const skipNodeInstall = isStatic || isLaravel;

    const { previewBounds, preferredPort } = await this.reservePreviewPort(projectId);

    // When Claudable runs remotely (e.g. on a server), localhost:<port> is not
    // reachable from the user's browser. PREVIEW_URL_TEMPLATE (e.g.
    // "https://preview-{port}.example.com") yields a publicly-routed URL instead.
    const buildPreviewUrl = (port: number): string => previewUrlFor(projectId, port);

    const initialUrl = buildPreviewUrl(preferredPort);

    const { env, dbIsContainer, projectDbUrl, injectedEnv } =
      await buildBaseSpawnEnv(projectId, preferredPort, initialUrl);

    const previewProcess: PreviewProcess = {
      process: null,
      port: preferredPort,
      url: initialUrl,
      status: 'starting',
      logs: [],
      startedAt: new Date(),
      lastAccessedAt: new Date(),
    };

    const log = this.getLogger(previewProcess);
    const flushPendingLogs = () => {
      if (pendingLogs.length === 0) {
        return;
      }
      const entries = pendingLogs.splice(0);
      entries.forEach((entry) => log(Buffer.from(entry)));
    };
    flushPendingLogs();

    // Per-project MANAGED CONTAINERS (composition step 3): start the project's
    // own containers (its Postgres DB, a cache, …) on its INTERNAL network before
    // the app that uses them. Each is reachable ONLY by this project (alias, no
    // host port); the DB kind is what DATABASE_URL above points at (…@db:5432/…).
    if (isolationEnabled()) {
      // Start them AND wait for readiness (a just-started Postgres must accept
      // connections before the first SSR/API request queries it on a cold start).
      try { await ensureServicesRunning(projectId, (line) => log(Buffer.from(line))); }
      catch (e) { log(Buffer.from(`[svc] start failed: ${(e as Error).message}`)); }
    }

    if (!skipNodeInstall) await this.ensureDependenciesWithLock(projectId, projectPath, env, log);

    const packageJson = skipNodeInstall ? null : await readPackageJson(projectPath);
    const hasPredev = Boolean(packageJson?.scripts?.predev);

    if (hasPredev) {
      await appendCommandLogs(npmCommand, ['run', 'predev'], projectPath, env, log);
    }

    const { effectivePort, resolvedUrl } = await applyEnvOverrides({
      projectPath,
      previewBounds,
      previewProcess,
      env,
      queueLog,
      log,
      flushPendingLogs,
      buildPreviewUrl,
    });

    // Per-project mode: (re)write this project's Traefik route to the current port
    // so the stable subdomain always points at THIS project's dev server.
    await publishPreviewRouteAndWarmCert(projectId, effectivePort, resolvedUrl);

    const { devArgs, bindHost, previewPublishHost } =
      await buildDevServerArgs(projectId, effectivePort, resolvedUrl);

    // Static imports run our dependency-free node server instead of `npm run dev`.
    let command = npmCommand;
    let args = devArgs;
    let spawnEnv: NodeJS.ProcessEnv = { ...env };
    let backendChild: ChildProcess | null = null;
    let backendContainer: string | null = null;
    let frontendContainer: string | null = null;
    // B6: if start() throws before the preview is tracked (this.processes.set),
    // tear down anything we already started so it doesn't leak as an orphan.
    // `committed` flips true at the tracking point, after which the exit/error
    // handlers (and stop()) own teardown.
    let committed = false;
    try {
    const cfg = await readPreviewConfig(projectPath);
    const sandboxNet = process.env.PREVIEW_SANDBOX_NETWORK?.trim();

    // Phase 2: run a framework project's dev server in an isolated container.
    // AGNOSTIC — auto-applies to ANY nuxt/next/angular project when
    // PREVIEW_ISOLATION is on; a project can opt OUT with `frontend.isolate:false`
    // in preview.json. Skipped when the project has a DB (the egress lock would
    // block a box-hosted Postgres). Uses a FOREGROUND `docker run` so it reuses
    // the existing spawn/readiness/log machinery below unchanged.
    // A CONTAINER DB lives on the project's internal net, so the frontend CAN be
    // containerized and reach it at db:5432 — only a legacy HOST DB (blocked by
    // the egress lock) forces the frontend to stay in-process.
    // Laravel ALWAYS runs containerized (PHP bootstrap needs composer/artisan in
    // the image); the node stacks containerize only when isolation is on and no
    // legacy host DB is in play.
    const useFrontendContainer =
      !isStatic && isolationEnabled() && (!projectDbUrl || dbIsContainer) &&
      (feKind === 'nuxt' || feKind === 'next' || feKind === 'angular' || isLaravel) &&
      cfg?.frontend?.isolate !== false;
    // A Laravel project can only run via the container path. If isolation is off
    // (local dev) or opted out, there is no in-process PHP fallback — fail with a
    // clear message rather than silently trying `npm run dev`.
    if (isLaravel && !useFrontendContainer) {
      throw new Error('The Filament (Laravel) stack requires the containerized preview (PREVIEW_ISOLATION). It cannot run in the in-process dev server.');
    }

    const composed = await startComposedBackend({
      projectId,
      projectPath,
      isStatic,
      cfg,
      effectivePort,
      resolvedUrl,
      injectedEnv,
      projectDbUrl,
      previewPublishHost,
      previewProcess,
      log,
    });
    backendContainer = composed.backendContainer;
    const composedBackendUrl = composed.composedBackendUrl;
    const composedInternalUrl = composed.composedInternalUrl;

    if (isStatic) {
      const staticStart = await startStaticServer({
        projectId,
        projectPath,
        cfg,
        effectivePort,
        bindHost,
        spawnEnv,
        log,
      });
      command = staticStart.command;
      args = staticStart.args;
      backendChild = staticStart.backendChild;
      backendContainer = staticStart.backendContainer;
    } else if (useFrontendContainer) {
      frontendContainer = `claudable-preview-${previewSlug(projectId)}`;
      const fe = await buildFrontendContainerArgs({
        projectId,
        projectPath,
        cfg,
        feName: frontendContainer,
        effectivePort,
        devArgs,
        previewPublishHost,
        sandboxNet,
        composedBackendUrl,
        composedInternalUrl,
        injectedEnv,
        kind: feKind,
        log,
      });
      command = fe.command;
      args = fe.args;
      previewProcess.frontendEnvFileCleanup = fe.envFileCleanup;
    }

    // SECURITY: the IN-PROCESS framework dev server runs the PROJECT's own server
    // code (Next API routes, Nuxt server routes), so it must NOT inherit
    // Claudable's secrets. Rebuild its env from the secret-free allowlist + only
    // the project-specific vars. (The container path is safe — secrets stay in the
    // docker CLI and never enter the container; the static server is Claudable's
    // own trusted code and keeps its CLAUDABLE_PROXY_* vars.)
    if (!isStatic && !useFrontendContainer && command === npmCommand) {
      spawnEnv = await buildScrubbedEnv({
        projectId,
        effectivePort,
        env,
        projectDbUrl,
        composedBackendUrl,
      });
    }

    const child = spawn(
      command,
      args,
      {
        cwd: projectPath,
        env: spawnEnv,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group so we can kill the WHOLE tree (npm -> sh -> nuxt).
        // Killing just the parent left the nuxt child holding the port, leaking
        // a dev server on every restart.
        detached: process.platform !== 'win32',
      }
    );

    // Join the isolated frontend container to the project net so its SERVER-SIDE
    // code reaches this project's own services directly: the backend at
    // http://api:<port> (composedInternalUrl) AND any managed service by alias
    // (db:5432, cache:6379, …). Join whenever there's ANYTHING to reach — a
    // composed backend OR any managed container that exposes env (not just a DB),
    // else a Redis-only project's `cache` alias wouldn't resolve. `docker run`
    // creates the container async, so connectToProjectNet retries.
    if (useFrontendContainer && (composedInternalUrl || Object.keys(injectedEnv).length > 0)) {
      void ensureProjectNetwork(projectId).then((net) =>
        connectToProjectNet(net, `claudable-preview-${previewSlug(projectId)}`));
    }

    previewProcess.process = child;
    previewProcess.backendProcess = backendChild;
    previewProcess.backendContainer = backendContainer;
    previewProcess.frontendContainer = frontendContainer;
    this.processes.set(projectId, previewProcess);
    committed = true; // tracked now — exit/error handlers + stop() own teardown
    // Now tracked via `processes` — free the in-flight reservation.
    this.reservedPorts.delete(preferredPort);

    // Refresh this project's architecture summary (best-effort, non-blocking).
    void writeArchitectureSummary({
      projectPath, projectName: project.name, templateType: project.templateType,
      isStatic, frontendContainer, backendContainer, backendInProcess: !!backendChild,
      proxy: cfg?.proxy, port: effectivePort, url: initialUrl, dbUrl: projectDbUrl,
      sandboxNet,
    });

    this.attachChildHandlers(child, projectId, previewProcess, log);

    await awaitReadinessAndFinalize({
      projectId,
      previewProcess,
      useFrontendContainer,
      previewPublishHost,
      effectivePort,
      log,
    });

    // Refresh the dashboard thumbnail once the app has had time to render —
    // server-side, so tiles refill on ANY preview start (share links, API,
    // auto-start), not only when the chat page is open. Retries on a backoff:
    // a slow first compile can outlive the readiness window, and a single
    // early attempt would silently miss. captureThumbnail quality-gates
    // (HTTP 200) and never overwrites a good shot with a bad one.
    // Dynamic import: thumbnail.ts imports previewManager from this module.
    void import('./thumbnail')
      .then((m) => m.captureThumbnailWithRetry(projectId))
      .catch(() => {});

    return this.toInfo(previewProcess);
    } catch (err) {
      if (!committed) {
        // Nothing tracks these yet — clean up so a mid-start failure doesn't
        // leave an orphaned container/process (and free the reserved port).
        killProcessTree(backendChild);
        removeBackendContainer(backendContainer);
        removeBackendContainer(frontendContainer);
        previewProcess.frontendEnvFileCleanup?.();
        this.reservedPorts.delete(preferredPort);
      }
      throw err;
    }
  }

  /**
   * After an agent turn: if the project runs a COMPILED/production backend container
   * (no in-container watcher) and its source changed since the container was built,
   * rebuild + restart it so the agent's edits actually take effect. Frontend dev
   * servers (HMR) and `dev:true` backends (air / --watch / --reload) self-reload and
   * are never rebuilt here. Best-effort — never throws into the caller.
   */
  public async rebuildBackendIfChanged(projectId: string): Promise<boolean> {
    const p = this.processes.get(projectId);
    if (!p || !p.rebuildBackend || !p.backendSrcDir) return false;
    try {
      const latest = await latestMtimeMs(p.backendSrcDir);
      if (latest > (p.backendBuiltAt ?? 0)) {
        await p.rebuildBackend();
        return true;
      }
    } catch { /* best-effort */ }
    return false;
  }

  /**
   * Tear down the composed backend NOW (its `-api` container + route + rebuild
   * hook), used when the user removes the backend from a live project — else the
   * old `-api` container keeps serving until the next preview restart. Best-effort.
   */
  public async removeComposedBackend(projectId: string): Promise<void> {
    removeBackendContainer(`${backendContainerName(projectId)}-api`);
    await removeBackendRoute(projectId).catch(() => {});
    const p = this.processes.get(projectId);
    if (p) { p.backendContainer = null; p.rebuildBackend = null; p.backendSrcDir = null; }
  }

  public async stop(projectId: string): Promise<PreviewInfo> {
    // Withdraw the project's preview route so its subdomain stops resolving to a
    // now-dead port (leaving it would 502; worse, the port could be reused).
    await removePreviewRoute(projectId);
    await removeBackendRoute(projectId).catch(() => {});
    const processInfo = this.processes.get(projectId);
    if (!processInfo) {
      const project = await getProjectById(projectId);
      if (project) {
        await updateProject(projectId, {
          previewUrl: null,
          previewPort: null,
        });
        await updateProjectStatus(projectId, 'idle');
      }
      return {
        port: null,
        url: null,
        status: 'stopped',
        logs: [],
      };
    }

    try {
      killProcessTree(processInfo.process);
      killProcessTree(processInfo.backendProcess);
      removeBackendContainer(processInfo.backendContainer);
      removeBackendContainer(processInfo.frontendContainer);
      processInfo.frontendEnvFileCleanup?.();
      processInfo.frontendEnvFileCleanup = null;
      void removeProjectNetwork(projectId); // Phase 1: drop the per-project net
    } catch (error) {
      console.error('[PreviewManager] Failed to stop preview process:', error);
    }

    this.processes.delete(projectId);
    await updateProject(projectId, {
      previewUrl: null,
      previewPort: null,
    });
    await updateProjectStatus(projectId, 'idle');

    return {
      port: null,
      url: null,
      status: 'stopped',
      logs: processInfo.logs,
    };
  }

  public getStatus(projectId: string): PreviewInfo {
    const processInfo = this.processes.get(projectId);
    if (!processInfo) {
      return {
        port: null,
        url: null,
        status: 'stopped',
        logs: [],
      };
    }
    // A status read means someone's looking at this preview — keep it warm so the
    // idle sweep doesn't evict an actively-viewed preview.
    processInfo.lastAccessedAt = new Date();
    return this.toInfo(processInfo);
  }

  public getLogs(projectId: string): string[] {
    const processInfo = this.processes.get(projectId);
    return processInfo ? [...processInfo.logs] : [];
  }

  private toInfo(processInfo: PreviewProcess): PreviewInfo {
    return {
      port: processInfo.port,
      url: processInfo.url,
      status: processInfo.status,
      logs: [...processInfo.logs],
      pid: processInfo.process?.pid,
    };
  }
}

const globalPreviewManager = globalThis as unknown as {
  __claudable_preview_manager__?: PreviewManager;
};

export const previewManager: PreviewManager =
  globalPreviewManager.__claudable_preview_manager__ ??
  (globalPreviewManager.__claudable_preview_manager__ = new PreviewManager());
