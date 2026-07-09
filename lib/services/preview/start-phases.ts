// Phase functions for PreviewManager.startInternal — verbatim slices of the original start sequence.
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { getProjectById, updateProject } from '../project';
import { getDatabaseUrl } from '@/lib/services/database';
import { getInjectedEnv } from '@/lib/services/managed-containers';
import { recordBackendChunk } from '@/lib/services/diagnostics';
import { listEnvVars } from '@/lib/services/env';
import { scaffoldForStack } from '@/lib/utils/scaffold-dispatch';
import { stackKind } from '@/lib/config/stacks';
import { ensureProjectRootStructure } from './scaffold';
import { ensurePreviewRouteReporter } from './route-reporter';
import {
  perProjectPreview,
  writePreviewRoute,
  writeBackendRoute,
  backendPreviewUrl,
  previewSlug,
} from './routes';
import {
  isolationEnabled,
  deriveBackendPort,
  BACKEND_PORT_OFFSET,
  backendContainerName,
  runBackendContainer,
  dockerRmSync,
  ensureProjectNetwork,
  connectToProjectNet,
  toHostPath,
  writeContainerEnvFile,
} from './docker';
import {
  substVars,
  buildBackendBaseEnv,
  collectEnvOverrides,
  parsePort,
  type PreviewConfig,
} from './config';
import { ensureStaticServer } from './static-server';
import { waitForPreviewReady, appendCommandLogs } from './process-utils';
import type { PreviewProcess } from './types';

type ProjectRecord = NonNullable<Awaited<ReturnType<typeof getProjectById>>>;

export interface ProjectWorkspace {
  project: ProjectRecord;
  projectPath: string;
  isStatic: boolean;
  pendingLogs: string[];
  queueLog: (message: string) => void;
}

/** Load the project, ensure its directory/root structure, scaffold if needed. */
export async function resolveProjectWorkspace(projectId: string): Promise<ProjectWorkspace> {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  const projectPath = project.repoPath
    ? path.resolve(project.repoPath)
    : path.join(process.cwd(), 'projects', projectId);

  await fs.mkdir(projectPath, { recursive: true });

  // `static` = an imported existing site (e.g. a single index.html). It is
  // never scaffolded, has no npm deps, and is served by a plain static file
  // server instead of a framework dev server.
  const isStatic = stackKind(project.templateType) === 'static';

  const pendingLogs: string[] = [];
  const queueLog = (message: string) => {
    const formatted = `[PreviewManager] ${message}`;
    console.log(formatted);
    pendingLogs.push(formatted);
  };

  await ensureProjectRootStructure(projectPath, queueLog, stackKind(project.templateType));

  if (!isStatic) {
    try {
      await fs.access(path.join(projectPath, 'package.json'));
    } catch {
      const proj = await getProjectById(projectId).catch(() => null);
      console.log(
        `[PreviewManager] Bootstrapping ${stackKind(proj?.templateType)} app for project ${projectId}`
      );
      await scaffoldForStack(projectPath, projectId, proj?.templateType, proj?.name);
    }

    // Make the preview report its route to the URL bar (cross-origin iframe).
    await ensurePreviewRouteReporter(projectPath, projectId);
  } else {
    // kind-static projects skip npm/scaffold — EXCEPT 'document', which starts
    // from a print-ready index.html (scaffoldDocumentApp is a no-op once it exists).
    const proj = await getProjectById(projectId).catch(() => null);
    if (proj?.templateType === 'document') {
      await scaffoldForStack(projectPath, projectId, proj.templateType);
    }
  }

  return { project, projectPath, isStatic, pendingLogs, queueLog };
}

export interface BaseSpawnEnv {
  env: NodeJS.ProcessEnv;
  dbIsContainer: boolean;
  projectDbUrl: string | null;
  injectedEnv: Record<string, string>;
}

/** Base dev-server env: dev mode, port, app URL, and the project's DB/service env. */
export async function buildBaseSpawnEnv(
  projectId: string,
  preferredPort: number,
  initialUrl: string
): Promise<BaseSpawnEnv> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // `next dev` must run in development; the Claudable container sets
    // NODE_ENV=production, which breaks the dev CSS loader (globals.css
    // "Module parse failed") and yields 500s in the preview.
    NODE_ENV: 'development',
    PORT: String(preferredPort),
    WEB_PORT: String(preferredPort),
    NEXT_PUBLIC_APP_URL: initialUrl,
  };

  // Expose DATABASE_URL to the dev server. Prefer the per-project CONTAINER DB
  // (internal @db:5432, reachable over the project net; the URL comes from the
  // stored spec, so it's known before the container is started below); fall back
  // to a legacy Coolify host DB. NOTE: distinct from Claudable's own DATABASE_URL
  // (always in process.env). A CONTAINER db does NOT block frontend isolation
  // (below); a host DB still does, since the egress lock would cut it off.
  let dbIsContainer = false;
  let projectDbUrl: string | null = null;
  let injectedEnv: Record<string, string> = {};
  try {
    // Every managed container's exposed env (DATABASE_URL, REDIS_URL, …) —
    // generic, so a Redis/Mongo/custom service is injected the same way a DB is.
    injectedEnv = isolationEnabled() ? await getInjectedEnv(projectId) : {};
    Object.assign(env, injectedEnv);
    const containerDbUrl = injectedEnv.DATABASE_URL || null;
    dbIsContainer = !!containerDbUrl;
    projectDbUrl = containerDbUrl || await getDatabaseUrl(projectId);
    if (projectDbUrl) env.DATABASE_URL = projectDbUrl;
  } catch { /* non-fatal */ }

  return { env, dbIsContainer, projectDbUrl, injectedEnv };
}

export interface EnvOverridesContext {
  projectPath: string;
  previewBounds: { start: number; end: number };
  previewProcess: PreviewProcess;
  env: NodeJS.ProcessEnv;
  queueLog: (message: string) => void;
  log: (chunk: Buffer | string) => void;
  flushPendingLogs: () => void;
  buildPreviewUrl: (port: number) => string;
}

/** Apply the project's own .env PORT/URL overrides; resolve the final port + URL. */
export async function applyEnvOverrides(
  ctx: EnvOverridesContext
): Promise<{ effectivePort: number; resolvedUrl: string }> {
  const { projectPath, previewBounds, previewProcess, env, queueLog, log, flushPendingLogs, buildPreviewUrl } = ctx;

  const overrides = await collectEnvOverrides(projectPath);

  if (overrides.port) {
    if (
      overrides.port < previewBounds.start ||
      overrides.port > previewBounds.end
    ) {
      queueLog(
        `Ignoring project-specified port ${overrides.port} because it falls outside the allowed preview range ${previewBounds.start}-${previewBounds.end}.`
      );
      delete overrides.port;
    }
  }

  if (overrides.url) {
    try {
      const parsed = new URL(overrides.url);
      if (parsed.port) {
        const parsedPort = parsePort(parsed.port);
        if (
          parsedPort &&
          (parsedPort < previewBounds.start ||
            parsedPort > previewBounds.end)
        ) {
          queueLog(
            `Ignoring project-specified NEXT_PUBLIC_APP_URL (${overrides.url}) because port ${parsed.port} is outside the allowed preview range ${previewBounds.start}-${previewBounds.end}.`
          );
          delete overrides.url;
        }
      }
    } catch {
      queueLog(
        `Ignoring project-specified NEXT_PUBLIC_APP_URL (${overrides.url}) because it could not be parsed as a valid URL.`
      );
      delete overrides.url;
    }
  }

  flushPendingLogs();

  if (overrides.port && overrides.port !== previewProcess.port) {
    previewProcess.port = overrides.port;
    env.PORT = String(overrides.port);
    env.WEB_PORT = String(overrides.port);
    log(
      Buffer.from(
        `[PreviewManager] Detected project-specified port ${overrides.port}.`
      )
    );
  }

  const effectivePort = previewProcess.port;
  let resolvedUrl: string = buildPreviewUrl(effectivePort);
  if (typeof overrides.url === 'string' && overrides.url.trim().length > 0) {
    resolvedUrl = overrides.url.trim();
  }

  env.NEXT_PUBLIC_APP_URL = resolvedUrl;
  previewProcess.url = resolvedUrl;

  return { effectivePort, resolvedUrl };
}

/**
 * Per-project mode: (re)write this project's Traefik route to the current port
 * so the stable subdomain always points at THIS project's dev server.
 */
export async function publishPreviewRouteAndWarmCert(
  projectId: string,
  effectivePort: number,
  resolvedUrl: string
): Promise<void> {
  if (!perProjectPreview()) return;
  await writePreviewRoute(projectId, effectivePort);
  // Pre-warm the LE cert in the background: the first HTTPS hit to a new
  // subdomain triggers DNS-01 issuance (~30-60s). Firing it now (non-blocking)
  // means the cert is usually ready by the time the user's browser loads.
  // Manual controller so the timer clears when the fetch settles (no lingering
  // 90s timer on the common warm-cert path).
  const warmCtrl = new AbortController();
  const warmTimer = setTimeout(() => warmCtrl.abort(), 90_000);
  void fetch(resolvedUrl, { method: 'HEAD', signal: warmCtrl.signal }).catch(() => {}).finally(() => clearTimeout(warmTimer));
}

/** Per-stack dev-server args + the bind host and the host interface to publish on. */
export async function buildDevServerArgs(
  projectId: string,
  effectivePort: number,
  resolvedUrl: string
): Promise<{ devArgs: string[]; bindHost: string | undefined; previewPublishHost: string }> {
  // Bind to all interfaces when hosting remotely so the reverse proxy can
  // reach the dev server (network_mode host -> proxy hits it via the gateway).
  const bindHost = process.env.PREVIEW_BIND_HOST;
  // Publish preview ports on the reverse-proxy GATEWAY IP (a private 10/8 addr,
  // egress-firewalled away from sandbox containers), NOT 0.0.0.0. On 0.0.0.0 the
  // port lands on every host interface incl. the box's PUBLIC IP, so a sandbox
  // container could reach another project's preview via the public-IP hairpin —
  // bypassing enable_icc + the private-range egress block (cross-project leak).
  // Traefik still reaches previews (it targets the gateway IP). Falls back to
  // 0.0.0.0 for local dev where no gateway is set.
  const previewPublishHost = (process.env.PREVIEW_PUBLISH_HOST || process.env.DEPLOY_HOST_GATEWAY || '0.0.0.0').trim() || '0.0.0.0';
  const devArgs = ['run', 'dev', '--', '--port', String(effectivePort)];
  const previewProject = await getProjectById(projectId).catch(() => null);
  if (stackKind(previewProject?.templateType) === 'angular') {
    // Angular's dev server rejects unknown Host headers, and the preview is
    // reached via the public host — allow it explicitly. Derived from the
    // resolved URL (no infra domain hardcoded); honored by the v20 builder.
    try {
      const host = new URL(resolvedUrl).hostname;
      if (host) devArgs.push('--allowed-hosts', host);
    } catch {
      /* keep default args */
    }
  } else if (bindHost && bindHost.trim().length > 0) {
    // Bind the dev server to all interfaces. Frameworks disagree on the flag:
    // Nuxt (v3 AND v4) uses `--host` — passing the unknown `--hostname` makes
    // Nuxt 4 treat the value (0.0.0.0) as a positional rootDir, so it can't
    // find app.vue/pages and falls back to the default welcome page. Next.js
    // uses `--hostname`. Match the flag to the framework.
    if (stackKind(previewProject?.templateType) === 'nuxt') {
      devArgs.push('--host', bindHost.trim());
    } else {
      devArgs.push('--hostname', bindHost.trim());
    }
  }
  return { devArgs, bindHost, previewPublishHost };
}

export interface ComposedBackendContext {
  projectId: string;
  projectPath: string;
  isStatic: boolean;
  cfg: PreviewConfig | null;
  effectivePort: number;
  resolvedUrl: string;
  injectedEnv: Record<string, string>;
  projectDbUrl: string | null;
  previewPublishHost: string;
  previewProcess: PreviewProcess;
  log: (chunk: Buffer | string) => void;
}

export interface ComposedBackendResult {
  backendContainer: string | null;
  composedBackendUrl: string | null;
  composedInternalUrl: string | null;
}

/**
 * Composed backend (model B): a framework project with a backend runs the
 * backend as its OWN isolated service on preview-<slug>-api (published on all
 * interfaces for Traefik), and the frontend calls it via an injected API base
 * URL. The backend port is derived (frontend port + 5000) so it needs no
 * second pool slot. CORS on the backend allows the frontend origin.
 */
export async function startComposedBackend(ctx: ComposedBackendContext): Promise<ComposedBackendResult> {
  const { projectId, projectPath, isStatic, cfg, effectivePort, resolvedUrl, injectedEnv, projectDbUrl, previewPublishHost, previewProcess, log } = ctx;

  let backendContainer: string | null = null;
  let composedBackendUrl: string | null = null;
  let composedInternalUrl: string | null = null; // Phase 1: direct http://api:<port> over the project net
  const composedBackendPort = (!isStatic && isolationEnabled() && cfg?.backend?.container)
    ? deriveBackendPort(effectivePort) : null;
  if (!isStatic && isolationEnabled() && cfg?.backend?.container && composedBackendPort === null) {
    log(Buffer.from(`[backend] derived backend port (${effectivePort + BACKEND_PORT_OFFSET}) is out of range; skipping composed backend.`));
  }
  if (!isStatic && isolationEnabled() && cfg?.backend?.container && composedBackendPort !== null) {
    const c = cfg.backend.container;
    const backendPort = composedBackendPort;
    const beName = `${backendContainerName(projectId)}-api`;
    // Env recomputed on every (re)build so the backend picks up the latest Env-tab
    // vars + managed-service connection strings.
    const computeCenv = async (): Promise<Record<string, string>> => {
      const cvars = { PROJECT: projectPath, PORT: String(c.port) };
      const cenv: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.env ?? {})) cenv[k] = substVars(String(v), cvars);
      cenv.CORS_ORIGIN = resolvedUrl; // allow the frontend's origin
      Object.assign(cenv, injectedEnv);          // db:5432, cache:6379, …
      if (projectDbUrl) cenv.DATABASE_URL = projectDbUrl;
      try { for (const ev of await listEnvVars(projectId)) cenv[ev.key] = ev.value; } catch { /* best-effort */ }
      return cenv;
    };
    // Build the image + run the container + join the project net (alias `api`).
    // Reused verbatim by the post-turn rebuild so a compiled/production backend
    // actually reflects the agent's source edits.
    const buildAndRunBackend = async (): Promise<string> => {
      const cenv = await computeCenv();
      const name = await runBackendContainer(projectId, projectPath, c, backendPort, cenv, log, previewPublishHost, beName);
      const projNet = await ensureProjectNetwork(projectId);
      await connectToProjectNet(projNet, beName, 'api');
      return name;
    };
    try {
      backendContainer = await buildAndRunBackend();
      composedInternalUrl = `http://api:${c.port}`;
      log(Buffer.from(`[PreviewManager] [backend] direct internal path ${composedInternalUrl} (project net claudable-proj-${previewSlug(projectId)})`));
      await writeBackendRoute(projectId, backendPort);
      composedBackendUrl = backendPreviewUrl(projectId, backendPort);
      log(Buffer.from(`[PreviewManager] [backend] composed backend service on ${composedBackendUrl}`));
      // Pre-warm the -api subdomain's LE cert.
      const bwCtrl = new AbortController();
      const bwTimer = setTimeout(() => bwCtrl.abort(), 90_000);
      void fetch(composedBackendUrl, { method: 'HEAD', signal: bwCtrl.signal }).catch(() => {}).finally(() => clearTimeout(bwTimer));
      // Register the rebuild hook: a `dev:true` backend hot-reloads via its own
      // watcher, so only a NON-dev (compiled/production) backend needs a rebuild
      // after edits. Watch the Dockerfile's dir (where the backend source lives).
      if (!c.dev) {
        previewProcess.backendSrcDir = path.resolve(projectPath, path.dirname(c.dockerfile));
        previewProcess.backendBuiltAt = Date.now();
        previewProcess.rebuildBackend = async () => {
          log(Buffer.from('[PreviewManager] [backend] source changed — rebuilding backend container…'));
          const name = await buildAndRunBackend();
          previewProcess.backendContainer = name;
          previewProcess.backendBuiltAt = Date.now();
          log(Buffer.from('[PreviewManager] [backend] rebuild complete.'));
        };
      }
    } catch (e) {
      log(Buffer.from(`[backend] composed backend failed: ${(e as Error).message}`));
    }
  }

  return { backendContainer, composedBackendUrl, composedInternalUrl };
}

export interface StaticServerContext {
  projectId: string;
  projectPath: string;
  cfg: PreviewConfig | null;
  effectivePort: number;
  bindHost: string | undefined;
  spawnEnv: NodeJS.ProcessEnv;
  log: (chunk: Buffer | string) => void;
}

export interface StaticServerResult {
  command: string;
  args: string[];
  backendChild: ChildProcess | null;
  backendContainer: string | null;
}

/** Static imports run our dependency-free node server (plus optional backend sidecar). */
export async function startStaticServer(ctx: StaticServerContext): Promise<StaticServerResult> {
  const { projectId, projectPath, cfg, effectivePort, bindHost, spawnEnv, log } = ctx;

  let backendChild: ChildProcess | null = null;
  let backendContainer: string | null = null;

  const serverPath = await ensureStaticServer();
  const command = process.execPath; // the node binary
  const args = [serverPath, String(effectivePort), (bindHost && bindHost.trim()) || '0.0.0.0', projectPath];

  // Optional backend sidecar (e.g. a Go service). Build it, run it on an
  // internal loopback port, and tell the static server to proxy to it.
  if (cfg?.backend && deriveBackendPort(effectivePort) === null) {
    log(Buffer.from(`[backend] derived port (${effectivePort + BACKEND_PORT_OFFSET}) out of range; skipping backend sidecar.`));
  }
  if (cfg?.backend && deriveBackendPort(effectivePort) !== null) {
    const backendPort = deriveBackendPort(effectivePort)!; // guaranteed in range
    const useContainer = isolationEnabled() && !!cfg.backend.container;

    if (useContainer) {
      // ISOLATED: build + run the backend in a hardened sibling container.
      const c = cfg.backend.container!;
      // Container-side env: config env ({PORT} = the port it LISTENS on inside
      // the container) + the project's own EnvVars. No Claudable env at all.
      const cvars = { PROJECT: projectPath, PORT: String(c.port) };
      const cenv: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.env ?? {})) cenv[k] = substVars(String(v), cvars);
      try {
        for (const ev of await listEnvVars(projectId)) cenv[ev.key] = ev.value;
      } catch { /* env vars are best-effort */ }
      try {
        backendContainer = await runBackendContainer(projectId, projectPath, c, backendPort, cenv, log);
      } catch (e) {
        log(Buffer.from(`[backend] container start failed: ${(e as Error).message}`));
      }
    } else if (isolationEnabled()) {
      // SECURITY: isolation is on but this backend declares no `container`.
      // We must NOT run its `preview.json` build/run commands on the HOST via
      // `sh -c` (that bypasses the sandbox and can read Claudable's files /
      // other projects). Refuse — the backend needs a `container` config.
      log(Buffer.from('[backend] skipped: isolation is on but this backend has no "container" config, so it will not run on the host. Add backend.container to run it isolated.'));
    } else {
      // IN-PROCESS (local dev only — PREVIEW_ISOLATION off): run the backend
      // as a child process. Never reached on the isolated (box) deployment.
      const vars = { PROJECT: projectPath, PORT: String(backendPort) };
      const bcwd = cfg.backend.cwd ? path.resolve(projectPath, cfg.backend.cwd) : projectPath;
      // Constrain cwd to the project (a `cwd: "../.."` must not escape).
      const projAbs = path.resolve(projectPath);
      if (bcwd !== projAbs && !bcwd.startsWith(projAbs + path.sep)) {
        log(Buffer.from('[backend] skipped: backend.cwd escapes the project directory.'));
        throw new Error('backend.cwd escapes project');
      }

      // Backend env = a SECRET-FREE base (buildBackendBaseEnv — no Claudable
      // credentials), then the config env (with {PROJECT}/{PORT} substituted),
      // then the project's own EnvVars (Envs tab) override.
      const backendEnv: Record<string, string> = buildBackendBaseEnv();
      for (const [k, v] of Object.entries(cfg.backend.env ?? {})) backendEnv[k] = substVars(String(v), vars);
      try {
        for (const ev of await listEnvVars(projectId)) backendEnv[ev.key] = ev.value;
      } catch { /* env vars are best-effort */ }

      await fs.mkdir(path.join(projectPath, '.claudable', 'backend-data'), { recursive: true });

      if (cfg.backend.build) {
        log(Buffer.from('[PreviewManager] [backend] building…'));
        await appendCommandLogs('sh', ['-c', substVars(cfg.backend.build, vars)], bcwd, backendEnv as NodeJS.ProcessEnv, log);
      }

      log(Buffer.from(`[PreviewManager] [backend] starting on 127.0.0.1:${backendPort}`));
      const bc = spawn('sh', ['-c', substVars(cfg.backend.run, vars)], {
        cwd: bcwd,
        env: backendEnv as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      backendChild = bc;
      bc.stdout?.on('data', (c) => { log(Buffer.from('[backend] ' + c.toString())); try { recordBackendChunk(projectId, c, 'stdout'); } catch { /* best-effort */ } });
      bc.stderr?.on('data', (c) => { log(Buffer.from('[backend] ' + c.toString())); try { recordBackendChunk(projectId, c, 'stderr'); } catch { /* best-effort */ } });
      bc.on('error', (e) => log(Buffer.from(`[backend] failed: ${e.message}`)));
    }

    // Wait for the backend (container OR process) to listen, then proxy to it.
    const healthUrl = `http://127.0.0.1:${backendPort}${cfg.backend.healthPath || '/'}`;
    await waitForPreviewReady(healthUrl, log).catch(() => false);

    spawnEnv.CLAUDABLE_PROXY_PORT = String(backendPort);
    spawnEnv.CLAUDABLE_PROXY_PREFIXES = (cfg.proxy && cfg.proxy.length ? cfg.proxy : ['/api']).join(',');
  }

  return { command, args, backendChild, backendContainer };
}

export interface FrontendContainerContext {
  projectId: string;
  projectPath: string;
  cfg: PreviewConfig | null;
  feName: string;
  effectivePort: number;
  devArgs: string[];
  previewPublishHost: string;
  sandboxNet: string | undefined;
  composedBackendUrl: string | null;
  composedInternalUrl: string | null;
  injectedEnv: Record<string, string>;
  /** Framework family — 'laravel' runs a PHP dev server (bootstraps Laravel +
   *  Filament); everything else runs the node dev server. */
  kind: import('@/lib/config/stacks').StackKind;
  log: (chunk: Buffer | string) => void;
}

// PHP image for the Filament (Laravel) preview — bundles composer + imagick +
// intl + pdo_pgsql/sqlite + gd/zip and runs cleanly as an arbitrary uid against
// a bind mount (verified). Pinned to 8.4: the golden template's composer.lock
// pins symfony/* v8.1 which requires php >=8.4.1 (composer.json's ^8.3 is a
// floor, not what the lock resolves to), so 8.3 fails `composer install`.
// Overridable per-project via preview.json frontend.image.
const LARAVEL_PHP_IMAGE = 'webdevops/php:8.4';

/**
 * Install + run for a Filament (Laravel) project scaffolded from the NewStory
 * golden template (see scaffold-filament.ts). The template's Laravel app lives
 * under `src/`, so everything runs from there. Idempotent: reuses vendor/,
 * node_modules/ and the shared composer cache on later starts. First boot is
 * slow (full composer install of the NewStory stack + a vite build); the
 * readiness poll tolerates that as long as the container does not exit.
 *
 * Preview-only env overrides are EXPORTED (not written to .env): the preview
 * never runs `config:cache`, so Laravel resolves config from live env() and
 * Dotenv (immutable) will not clobber an already-exported var. This keeps the
 * template's committed .env values intact while forcing preview-safe behaviour
 * (no external object store / SMTP / dbsync, local env so Filament serves
 * without the production TLS + panel gates). The heredoc-free lines keep the
 * whole thing a valid single `sh -c` argument.
 */
function laravelDevScript(port: number): string {
  return [
    'set -e',
    'export HOME=${HOME:-/tmp}',
    // The golden template is cloned at scaffold time (Claudable process, which
    // holds GIT_TOKEN). If its app is missing, fail loudly rather than silently
    // bootstrapping a bare Laravel — this stack IS the NewStory template.
    'if [ ! -f src/composer.json ]; then echo "[filament] ERROR: src/composer.json missing — the Filament template scaffold did not run (check GIT_TOKEN / filament-template repo access)"; exit 1; fi',
    'cd src',
    'echo "[filament] installing PHP dependencies (composer) — first start is slow…"',
    '[ -d vendor ] || composer install --no-interaction --no-progress',
    '[ -f .env ] || cp .env.example .env',
    // Preview-safe overrides (exported; see the doc comment above).
    'export APP_ENV=local',
    'export FILESYSTEM_DISK=public',
    'export MEDIA_DISK=public',
    'export MAIL_MAILER=log',
    'export DBSYNC_ENABLED=false',
    // DB: a managed Postgres container (injected DATABASE_URL, reachable on the
    // project net) when the project has one; else file SQLite. Parse the URL
    // into DB_* envs (robust — no reliance on a DB_URL config key).
    'if [ -n "${DATABASE_URL:-}" ]; then',
    '  export DB_CONNECTION=pgsql',
    '  export DB_HOST=$(echo "$DATABASE_URL" | sed -E "s#.*@([^:/]+).*#\\1#")',
    '  export DB_PORT=$(echo "$DATABASE_URL" | sed -E "s#.*@[^:]+:([0-9]+).*#\\1#")',
    '  export DB_DATABASE=$(echo "$DATABASE_URL" | sed -E "s#.*/([^/?]+).*#\\1#")',
    '  export DB_USERNAME=$(echo "$DATABASE_URL" | sed -E "s#.*://([^:]+):.*#\\1#")',
    '  export DB_PASSWORD=$(echo "$DATABASE_URL" | sed -E "s#.*://[^:]+:([^@]+)@.*#\\1#")',
    '  echo "[filament] using managed Postgres at ${DB_HOST}:${DB_PORT}/${DB_DATABASE}"',
    '  for i in $(seq 1 30); do php -r "new PDO(\\"pgsql:host=${DB_HOST};port=${DB_PORT};dbname=${DB_DATABASE}\\", \\"${DB_USERNAME}\\", \\"${DB_PASSWORD}\\");" 2>/dev/null && break || sleep 2; done',
    'else',
    '  export DB_CONNECTION=sqlite',
    '  mkdir -p database && touch database/database.sqlite',
    '  export DB_DATABASE="$(pwd)/database/database.sqlite"',
    '  echo "[filament] using file SQLite (no managed database attached)"',
    'fi',
    // Laravel needs these dirs to exist (a fresh clone may miss them).
    'mkdir -p storage/framework/cache/data storage/framework/sessions storage/framework/views bootstrap/cache',
    'grep -q "^APP_KEY=base64:" .env || php artisan key:generate --force',
    // Assets: the template ships a prebuilt public/build (vite manifest + theme),
    // so no npm/Node is needed here — the preview image is PHP-only. Just publish
    // Filament's own vendor assets (pure PHP copy). If the agent edits the vite
    // theme it rebuilds public/build itself (its image has Node); the preview
    // then serves the updated manifest.
    'php artisan filament:assets || true',
    'php artisan storage:link 2>/dev/null || true',
    'php artisan migrate --force || true',
    `echo "[filament] starting php artisan serve on ${port}"`,
    `exec php artisan serve --host 0.0.0.0 --port ${port}`,
  ].join('\n');
}

/**
 * Run the framework dev server inside an isolated, egress-locked container.
 * Foreground `docker run` == the child process, so stdout/readiness/status
 * teardown below all work unchanged; the container is `docker rm -f`'d too.
 */
export async function buildFrontendContainerArgs(
  ctx: FrontendContainerContext
): Promise<{ command: string; args: string[]; envFileCleanup: () => void }> {
  const { projectId, projectPath, cfg, feName, effectivePort, devArgs, previewPublishHost, sandboxNet, composedBackendUrl, composedInternalUrl, injectedEnv, kind, log } = ctx;
  const isLaravel = kind === 'laravel';

  const fe = cfg?.frontend ?? {}; // config optional — isolation is agnostic
  await dockerRmSync(feName); // clear any stale container before re-creating
  const hostProject = toHostPath(projectPath);
  const image = fe.image || (isLaravel ? LARAVEL_PHP_IMAGE : 'node:22-bookworm-slim');
  // Reuse the SAME per-stack dev command the in-process path builds (devArgs
  // already carries --port + the stack's host/allowed-hosts flags), so this
  // works for nuxt/next/angular without per-project config.
  // A CUSTOM fe.dev command is arbitrary shell (env-var prefixes, `;` chains) —
  // `exec` in front of it silently breaks both (exec replaces the shell with the
  // FIRST word: `exec FOO=x cmd` fails outright, `exec a; b` never runs b). Only
  // the default command we compose ourselves gets exec'd.
  const inner = fe.dev
    ? substVars(fe.dev, { PORT: String(effectivePort) })
    : isLaravel
    ? laravelDevScript(effectivePort)
    : `exec npm ${devArgs.join(' ')}`;
  // Clear Next's dev lock first: an OOM-kill / hard stop leaves .next/dev/lock
  // behind in the bind-mounted project, and the next `next dev` refuses to start
  // ("Unable to acquire lock") — every restart would fail until someone deletes
  // it by hand. Harmless for non-Next stacks (path simply doesn't exist).
  // --prefer-offline: reuse the shared npm cache (mounted below) instead of
  // re-downloading packages on every project's first install. Laravel supplies
  // its own bootstrap+serve script (composer, not npm), so use it verbatim.
  const devScript = isLaravel
    ? inner
    : `rm -rf .next/dev/lock 2>/dev/null; [ -d node_modules ] || npm install --prefer-offline --no-audit --no-fund; ${inner}`;

  // Shared package cache across ALL preview containers so a project's first
  // install reuses what others pulled. npm cacache (node) or composer cache
  // (laravel); both content-addressed → concurrent installs are safe. Dir lives
  // under the data root so it's node-owned (containers run as uid 1000).
  // Best-effort: never block a preview start on it.
  let cacheArgs: string[] = [];
  try {
    const dir = isLaravel ? '.composer-cache' : '.npm-cache';
    const cacheDir = path.resolve(path.dirname(process.env.PROJECTS_DIR || './data/projects'), dir);
    await fs.mkdir(cacheDir, { recursive: true });
    cacheArgs = ['-v', `${toHostPath(cacheDir)}:${isLaravel ? '/composer-cache' : '/npm-cache'}`];
  } catch { /* cache is an optimization only */ }
  // Build the container's env as an ordered record, then pass it via a single
  // 0600 env-file (writeContainerEnvFile) instead of `-e` on the argv. These
  // carry the PROJECT's secrets (DATABASE_URL, its own Env-tab values), and argv
  // is world-readable via /proc/<pid>/cmdline — the same exposure the agent-turn
  // path already closed. Claudable's own secrets are never included.
  //
  // Insertion order encodes precedence (env-file is last-wins per key, matching
  // the previous `-e` ordering): base runtime vars, then the composed-backend
  // URLs, then managed-service connection env (DATABASE_URL, REDIS_URL, … reached
  // over the project net the container joins below), then the project's own
  // Env-tab vars — so a project var of the same name wins.
  const feEnv: Record<string, string> = isLaravel
    ? {
        PORT: String(effectivePort),
        // artisan/composer need a writable HOME; composer cache is the mount.
        HOME: '/tmp',
        COMPOSER_NO_INTERACTION: '1',
        ...(cacheArgs.length ? { COMPOSER_CACHE_DIR: '/composer-cache' } : {}),
        // DB is decided at runtime by laravelDevScript: a managed Postgres
        // container (injected DATABASE_URL, on db:5432) when the project has one,
        // else a file SQLite fallback. NOT hardcoded here.
        APP_ENV: 'local',
        APP_DEBUG: 'true',
      }
    : {
        NODE_ENV: 'development',
        PORT: String(effectivePort),
        HOST: '0.0.0.0',
        // Point npm at the shared cache volume mounted below (node-owned bind mount).
        ...(cacheArgs.length ? { npm_config_cache: '/npm-cache' } : {}),
      };
  if (composedBackendUrl) {
    // Composed backend URL (model B): PUBLIC url for the BROWSER (client-side).
    feEnv.NUXT_PUBLIC_API_BASE = composedBackendUrl;
    feEnv.NEXT_PUBLIC_API_BASE = composedBackendUrl;
    feEnv.API_BASE_URL = composedBackendUrl;
  }
  if (composedInternalUrl) {
    // Phase 1: INTERNAL direct url for SERVER-SIDE calls (SSR / API routes / proxy)
    // — reaches the backend over the project net, no public round-trip.
    feEnv.API_INTERNAL_BASE = composedInternalUrl;
    feEnv.NUXT_API_BASE = composedInternalUrl;
    feEnv.INTERNAL_API_BASE = composedInternalUrl;
  }
  for (const [k, v] of Object.entries(injectedEnv)) feEnv[k] = v;
  try {
    for (const ev of await listEnvVars(projectId)) feEnv[ev.key] = ev.value;
  } catch { /* env vars are best-effort */ }
  const cenvFile = writeContainerEnvFile(feEnv);
  const command = 'docker';
  const args = [
    'run', '--rm', '--name', feName,
    '-w', '/app', '-v', `${hostProject}:/app`,
    // Publish on all host interfaces (not just loopback): the frontend is
    // reached by the reverse proxy at the host GATEWAY IP, not via 127.0.0.1
    // (unlike the backend sidecar, which Claudable's own static server
    // proxies to on loopback). Parity with the in-process 0.0.0.0 bind.
    '-p', `${previewPublishHost}:${effectivePort}:${effectivePort}`,
    // 2g default: Next 16 (Turbopack) and cold Nuxt/Vite builds routinely spike
    // past 1g during compile — at 1g the kernel OOM-kills next-server mid-start
    // and the preview dies with "exited before it became reachable".
    '--memory', fe.memory || '2g',
    '--cpus', String(fe.cpus || '2.0'),
    '--pids-limit', '512',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    // Node image ships a `node` user (uid 1000); the PHP image has no such
    // user, so pin the numeric uid/gid (matches the bind-mounted project owner)
    // and override its entrypoint to a plain shell.
    ...(isLaravel ? ['--user', '1000:1000', '--entrypoint', 'sh'] : ['--user', 'node']),
    ...cacheArgs,
    ...(sandboxNet ? ['--network', sandboxNet] : []),
    ...cenvFile.args,
    // PHP image: entrypoint is already `sh`, so pass just `-c <script>`.
    ...(isLaravel ? [image, '-c', devScript] : [image, 'sh', '-c', devScript]),
  ];
  // The docker CLI needs DOCKER_HOST (already in spawnEnv via process.env).
  log(Buffer.from(`[PreviewManager] [frontend] running dev server in isolated container ${feName} (mem ${fe.memory || '2g'}, cap-drop ALL, egress-locked)`));
  return { command, args, envFileCleanup: cenvFile.cleanup };
}

export interface ScrubbedEnvContext {
  projectId: string;
  effectivePort: number;
  env: NodeJS.ProcessEnv;
  projectDbUrl: string | null;
  composedBackendUrl: string | null;
}

/**
 * SECURITY: the IN-PROCESS framework dev server runs the PROJECT's own server
 * code (Next API routes, Nuxt server routes), so it must NOT inherit
 * Claudable's secrets. Rebuild its env from the secret-free allowlist + only
 * the project-specific vars. (The container path is safe — secrets stay in the
 * docker CLI and never enter the container; the static server is Claudable's
 * own trusted code and keeps its CLAUDABLE_PROXY_* vars.)
 */
export interface ReadinessContext {
  projectId: string;
  previewProcess: PreviewProcess;
  useFrontendContainer: boolean;
  previewPublishHost: string;
  effectivePort: number;
  log: (chunk: Buffer | string) => void;
}

/** Wait for the local dev server to answer, then persist the running state. */
export async function awaitReadinessAndFinalize(opts: ReadinessContext): Promise<void> {
  const { projectId, previewProcess, useFrontendContainer, previewPublishHost, effectivePort, log } = opts;

  // Probe the LOCAL dev server for readiness — never the public URL. In
  // per-project mode the public URL is a fresh subdomain whose Let's Encrypt
  // cert issues on first access (DNS-01, ~30-60s); gating readiness on that
  // made cold starts appear to hang. The dev server is "ready" once it answers
  // locally; the cert/route warm up in parallel (pre-warmed below).
  // Probe the interface the port is actually published on. The in-process /
  // static dev server runs on Claudable's loopback (127.0.0.1); the ISOLATED
  // frontend container publishes on previewPublishHost (the gateway IP, 10.0.1.1)
  // — probing 127.0.0.1 there would always "fetch failed" even though the server
  // is up. Claudable is host-networked, so the gateway IP is reachable.
  const readinessHost = (useFrontendContainer && previewPublishHost !== '0.0.0.0')
    ? previewPublishHost : '127.0.0.1';
  const readinessUrl = `http://${readinessHost}:${effectivePort}`;
  const ready = await waitForPreviewReady(readinessUrl, log).catch(
    () => false
  );

  // The dev server exited (crash/build failure) while we were waiting.
  if (
    previewProcess.status === 'error' ||
    previewProcess.status === 'stopped'
  ) {
    await updateProject(projectId, {
      previewUrl: null,
      previewPort: null,
      status: 'idle',
    }).catch(() => {});
    throw new Error(
      'Preview server exited before it became reachable. Check the build logs.'
    );
  }

  // Clear the "starting" state regardless of whether the stdout fast-path
  // fired — otherwise a server that logs nothing leaves the UI spinning
  // forever. If the health check never passed we still mark it running
  // (dev servers can be slow behind a proxy) but log the discrepancy.
  if (previewProcess.status === 'starting') {
    previewProcess.status = 'running';
  }
  if (!ready) {
    log(
      Buffer.from(
        '[PreviewManager] Health check did not pass within the timeout; marking running optimistically (process is still alive).'
      )
    );
  }

  await updateProject(projectId, {
    previewUrl: previewProcess.url,
    previewPort: previewProcess.port,
    status: 'running',
  });
}

export async function buildScrubbedEnv(ctx: ScrubbedEnvContext): Promise<NodeJS.ProcessEnv> {
  const { projectId, effectivePort, env, projectDbUrl, composedBackendUrl } = ctx;
  const scrubbed: Record<string, string> = buildBackendBaseEnv();
  scrubbed.NODE_ENV = 'development';
  scrubbed.PORT = String(effectivePort);
  scrubbed.WEB_PORT = String(effectivePort);
  if (env.NEXT_PUBLIC_APP_URL) scrubbed.NEXT_PUBLIC_APP_URL = String(env.NEXT_PUBLIC_APP_URL);
  if (projectDbUrl) scrubbed.DATABASE_URL = projectDbUrl;
  if (composedBackendUrl) {
    scrubbed.NUXT_PUBLIC_API_BASE = scrubbed.NEXT_PUBLIC_API_BASE = scrubbed.API_BASE_URL = composedBackendUrl;
  }
  const bindHostTrim = process.env.PREVIEW_BIND_HOST?.trim();
  if (bindHostTrim) scrubbed.PREVIEW_BIND_HOST = bindHostTrim;
  try { for (const ev of await listEnvVars(projectId)) scrubbed[ev.key] = ev.value; } catch { /* best-effort */ }
  return scrubbed as NodeJS.ProcessEnv;
}
