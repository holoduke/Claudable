/**
 * PreviewManager - Handles per-project development servers (live preview)
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { findAvailablePort } from '@/lib/utils/ports';
import { getProjectById, updateProject, updateProjectStatus } from './project';
import { scaffoldBasicNextApp } from '@/lib/utils/scaffold';
import { scaffoldIsClean } from '@/lib/config/stacks';
import { PREVIEW_CONFIG } from '@/lib/config/constants';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/**
 * Inject a tiny Nuxt client plugin that reports the current route to the
 * Claudable parent window via postMessage, so the preview URL bar follows
 * in-app (client-side) navigation. The preview is a cross-origin iframe, so the
 * parent can't read its location directly — this is the only reliable way.
 * The plugin is inert outside the preview iframe and is gitignored so it never
 * ships to the deployed app.
 */
async function ensurePreviewRouteReporter(projectPath: string): Promise<void> {
  try {
    // Only meaningful for Nuxt projects.
    const hasNuxtConfig = await fs
      .access(path.join(projectPath, 'nuxt.config.ts'))
      .then(() => true)
      .catch(() => false);
    if (!hasNuxtConfig) return;

    const rel = 'plugins/claudable-preview.client.ts';
    const pluginPath = path.join(projectPath, rel);
    await fs.mkdir(path.dirname(pluginPath), { recursive: true });
    await fs.writeFile(
      pluginPath,
      `// Auto-added by Claudable (preview only). Reports the current route to the
// Claudable parent window so the preview URL bar can follow in-app navigation.
// Inert outside the preview iframe; gitignored so it never ships to production.
export default defineNuxtPlugin(() => {
  if (typeof window === 'undefined' || window.parent === window) return;
  // Target the embedding (Claudable) origin rather than '*', so route paths
  // aren't broadcast to an arbitrary parent if this preview is framed elsewhere.
  let target = '*';
  try { if (document.referrer) target = new URL(document.referrer).origin; } catch {}
  const post = (p: string) => {
    try { window.parent.postMessage({ source: 'claudable-preview', path: p }, target); } catch {}
  };
  try {
    const router = useRouter();
    post(router.currentRoute.value.fullPath);
    router.afterEach((to) => post(to.fullPath));
  } catch {}
});
`,
      'utf8',
    );

    // Keep it out of git / the deployed image.
    const giPath = path.join(projectPath, '.gitignore');
    let gi = '';
    try { gi = await fs.readFile(giPath, 'utf8'); } catch { /* none yet */ }
    if (!gi.includes(rel)) {
      const sep = gi.length === 0 || gi.endsWith('\n') ? '' : '\n';
      await fs.writeFile(giPath, `${gi}${sep}${rel}\n`, 'utf8');
    }
  } catch {
    // Non-fatal: the route bar just won't follow in-app navigation.
  }
}

/**
 * Kill the dev server AND its children. The dev server is a tree
 * (run-dev.js -> npm -> sh -> nuxt); killing only the parent left the nuxt
 * child alive holding the port, leaking a server on every restart. The child
 * is spawned detached, so a negative PID signals the whole process group.
 */
function killProcessTree(child: ChildProcess | null | undefined): void {
  const pid = child?.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      child!.kill('SIGTERM');
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
      // Hard-stop the group shortly after if anything lingers.
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 4000).unref?.();
    } catch {
      child!.kill('SIGTERM');
    }
  } catch {
    /* already exited */
  }
}
const yarnCommand = process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
const bunCommand = process.platform === 'win32' ? 'bun.exe' : 'bun';

type PackageManagerId = 'npm' | 'pnpm' | 'yarn' | 'bun';

const PACKAGE_MANAGER_COMMANDS: Record<
  PackageManagerId,
  { command: string; installArgs: string[] }
> = {
  npm: { command: npmCommand, installArgs: ['install'] },
  pnpm: { command: pnpmCommand, installArgs: ['install'] },
  yarn: { command: yarnCommand, installArgs: ['install'] },
  bun: { command: bunCommand, installArgs: ['install'] },
};

const LOG_LIMIT = PREVIEW_CONFIG.LOG_LIMIT;
const PREVIEW_FALLBACK_PORT_START = PREVIEW_CONFIG.FALLBACK_PORT_START;
const PREVIEW_FALLBACK_PORT_END = PREVIEW_CONFIG.FALLBACK_PORT_END;
const PREVIEW_MAX_PORT = 65_535;
const ROOT_ALLOWED_FILES = new Set([
  '.DS_Store',
  '.editorconfig',
  '.env',
  '.env.development',
  '.env.local',
  '.env.production',
  '.eslintignore',
  '.eslintrc',
  '.eslintrc.cjs',
  '.eslintrc.js',
  '.eslintrc.json',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc',
  '.prettierrc.cjs',
  '.prettierrc.js',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'LICENSE',
  'README',
  'README.md',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'requirements.txt',
  'yarn.lock',
]);
const ROOT_ALLOWED_DIR_PREFIXES = ['.'];
const ROOT_ALLOWED_DIRS = new Set([
  '.git',
  '.idea',
  '.vscode',
  '.github',
  '.husky',
  '.pnpm-store',
  '.turbo',
  '.next',
  'node_modules',
]);
const ROOT_OVERWRITABLE_FILES = new Set([
  '.gitignore',
  '.eslintignore',
  '.env',
  '.env.development',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  'README',
  'README.md',
  'README.txt',
]);

type PreviewStatus = 'starting' | 'running' | 'stopped' | 'error';

interface PreviewProcess {
  process: ChildProcess | null;
  port: number;
  url: string;
  status: PreviewStatus;
  logs: string[];
  startedAt: Date;
  lastAccessedAt: Date;
}

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

interface EnvOverrides {
  port?: number;
  url?: string;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

function parsePort(value?: string): number | null {
  if (!value) return null;
  const numeric = Number.parseInt(stripQuotes(value), 10);
  if (Number.isFinite(numeric) && numeric > 0 && numeric <= 65535) {
    return numeric;
  }
  return null;
}

async function readPackageJson(
  projectPath: string
): Promise<Record<string, any> | null> {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function collectEnvOverrides(projectPath: string): Promise<EnvOverrides> {
  const overrides: EnvOverrides = {};
  const files = ['.env.local', '.env'];

  for (const fileName of files) {
    const filePath = path.join(projectPath, fileName);
    try {
      const contents = await fs.readFile(filePath, 'utf8');
      const lines = contents.split(/\r?\n/);
      let candidateUrl: string | null = null;

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || !line.includes('=')) {
          continue;
        }

        const [rawKey, ...rawValueParts] = line.split('=');
        const key = rawKey.trim();
        const rawValue = rawValueParts.join('=');
        const value = stripQuotes(rawValue);

        if (!overrides.port && (key === 'PORT' || key === 'WEB_PORT')) {
          const parsed = parsePort(value);
          if (parsed) {
            overrides.port = parsed;
          }
        }

        if (!overrides.url && key === 'NEXT_PUBLIC_APP_URL' && value) {
          candidateUrl = value;
        }
      }

      if (!overrides.url && candidateUrl) {
        overrides.url = candidateUrl;
      }

      if (!overrides.port && overrides.url) {
        try {
          const parsedUrl = new URL(overrides.url);
          if (parsedUrl.port) {
            const parsedPort = parsePort(parsedUrl.port);
            if (parsedPort) {
              overrides.port = parsedPort;
            }
          }
        } catch {
          // Ignore invalid URL formats
        }
      }

      if (overrides.port && overrides.url) {
        break;
      }
    } catch {
      // Missing env file is fine; skip
    }
  }

  return overrides;
}

function resolvePreviewBounds(): { start: number; end: number } {
  const envStartRaw = Number.parseInt(process.env.PREVIEW_PORT_START || '', 10);
  const envEndRaw = Number.parseInt(process.env.PREVIEW_PORT_END || '', 10);

  const start = Number.isInteger(envStartRaw)
    ? Math.max(1, envStartRaw)
    : PREVIEW_FALLBACK_PORT_START;

  let end = Number.isInteger(envEndRaw)
    ? Math.min(PREVIEW_MAX_PORT, envEndRaw)
    : PREVIEW_FALLBACK_PORT_END;

  if (end < start) {
    end = Math.min(start + (PREVIEW_FALLBACK_PORT_END - PREVIEW_FALLBACK_PORT_START), PREVIEW_MAX_PORT);
  }

  return { start, end };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function parsePackageManagerField(value: unknown): PackageManagerId | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const [rawName] = value.split('@');
  const name = rawName.trim().toLowerCase();
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    return name as PackageManagerId;
  }
  return null;
}

function isCommandNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as NodeJS.ErrnoException;
  return err.code === 'ENOENT';
}

async function detectPackageManager(projectPath: string): Promise<PackageManagerId> {
  const packageJson = await readPackageJson(projectPath);
  const fromField = parsePackageManagerField(packageJson?.packageManager);
  if (fromField) {
    return fromField;
  }

  if (await fileExists(path.join(projectPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (await fileExists(path.join(projectPath, 'yarn.lock'))) {
    return 'yarn';
  }
  if (await fileExists(path.join(projectPath, 'bun.lockb'))) {
    return 'bun';
  }
  if (await fileExists(path.join(projectPath, 'package-lock.json'))) {
    return 'npm';
  }
  return 'npm';
}

async function runInstallWithPreferredManager(
  projectPath: string,
  env: NodeJS.ProcessEnv,
  logger: (chunk: Buffer | string) => void
): Promise<void> {
  const manager = await detectPackageManager(projectPath);
  const { command, installArgs } = PACKAGE_MANAGER_COMMANDS[manager];

  logger(`[PreviewManager] Installing dependencies using ${manager}.`);
  try {
    await appendCommandLogs(command, installArgs, projectPath, env, logger);
  } catch (error) {
    if (manager !== 'npm' && isCommandNotFound(error)) {
      logger(
        `[PreviewManager] ${command} unavailable. Falling back to npm install.`
      );
      await appendCommandLogs(
        PACKAGE_MANAGER_COMMANDS.npm.command,
        PACKAGE_MANAGER_COMMANDS.npm.installArgs,
        projectPath,
        env,
        logger
      );
      return;
    }
    throw error;
  }
}

async function isLikelyNextProject(dirPath: string): Promise<boolean> {
  const pkgPath = path.join(dirPath, 'package.json');
  try {
    const pkgRaw = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgRaw);
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    if (typeof deps.next === 'string') {
      return true;
    }
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      const scriptValues = Object.values(pkg.scripts as Record<string, unknown>);
      if (
        scriptValues.some(
          (value) =>
            typeof value === 'string' &&
            (value.includes('next dev') || value.includes('next start'))
        )
      ) {
        return true;
      }
    }
  } catch {
    // ignore
  }

  const configCandidates = [
    'next.config.js',
    'next.config.cjs',
    'next.config.mjs',
    'next.config.ts',
  ];
  for (const candidate of configCandidates) {
    if (await fileExists(path.join(dirPath, candidate))) {
      return true;
    }
  }

  const appDirCandidates = [
    'app',
    path.join('src', 'app'),
    'pages',
    path.join('src', 'pages'),
  ];
  for (const candidate of appDirCandidates) {
    if (await directoryExists(path.join(dirPath, candidate))) {
      return true;
    }
  }

  return false;
}

function isAllowedRootFile(name: string): boolean {
  if (ROOT_ALLOWED_FILES.has(name)) {
    return true;
  }
  if (name.endsWith('.md') || name.startsWith('.env.')) {
    return true;
  }
  return false;
}

function isAllowedRootDirectory(name: string): boolean {
  if (ROOT_ALLOWED_DIRS.has(name)) {
    return true;
  }
  return ROOT_ALLOWED_DIR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isOverwritableRootFile(name: string): boolean {
  if (ROOT_OVERWRITABLE_FILES.has(name)) {
    return true;
  }
  if (name.startsWith('.env.') || name.endsWith('.md')) {
    return true;
  }
  return false;
}

async function ensureProjectRootStructure(
  projectPath: string,
  log: (message: string) => void
): Promise<void> {
  const entries = await fs.readdir(projectPath, { withFileTypes: true });
  const hasRootPackageJson = entries.some(
    (entry) => entry.isFile() && entry.name === 'package.json'
  );
  if (hasRootPackageJson) {
    return;
  }

  const candidateDirs: { name: string; path: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === 'node_modules') {
      continue;
    }
    const dirPath = path.join(projectPath, entry.name);
    // quick skip for empty directory
    const isCandidate = await isLikelyNextProject(dirPath);
    if (isCandidate) {
      candidateDirs.push({ name: entry.name, path: dirPath });
    }
  }

  if (candidateDirs.length === 0) {
    return;
  }

  if (candidateDirs.length > 1) {
    const dirNames = candidateDirs.map((dir) => dir.name).join(', ');
    throw new Error(
      `Multiple potential Next.js projects detected in subdirectories (${dirNames}). Please move the desired project files to the project root.`
    );
  }

  const candidate = candidateDirs[0];
  const { name: nestedName, path: nestedPath } = candidate;

  for (const entry of entries) {
    if (entry.name === nestedName) {
      continue;
    }
    if (entry.isDirectory()) {
      if (!isAllowedRootDirectory(entry.name)) {
        throw new Error(
          `Cannot normalize project structure because directory "${entry.name}" exists alongside "${nestedName}". Move project files to the root manually.`
        );
      }
      continue;
    }

    if (!isAllowedRootFile(entry.name)) {
      throw new Error(
        `Cannot normalize project structure because file "${entry.name}" exists alongside "${nestedName}". Move project files to the root manually.`
      );
    }
  }

  // Remove nested node_modules and root node_modules (if any) to avoid conflicts during move.
  await fs.rm(path.join(nestedPath, 'node_modules'), { recursive: true, force: true });
  await fs.rm(path.join(projectPath, 'node_modules'), { recursive: true, force: true });

  const nestedEntries = await fs.readdir(nestedPath, { withFileTypes: true });
  for (const nestedEntry of nestedEntries) {
    const sourcePath = path.join(nestedPath, nestedEntry.name);
    const destinationPath = path.join(projectPath, nestedEntry.name);
    if (await pathExists(destinationPath)) {
      if (nestedEntry.isFile() && isOverwritableRootFile(nestedEntry.name)) {
        await fs.rm(destinationPath, { force: true });
        await fs.rename(sourcePath, destinationPath);
        log(
          `Replaced existing root file "${nestedEntry.name}" with the version from "${nestedName}".`
        );
        continue;
      }
      throw new Error(
        `Cannot move "${nestedEntry.name}" from "${nestedName}" because "${nestedEntry.name}" already exists in the project root.`
      );
    }
    await fs.rename(sourcePath, destinationPath);
  }

  await fs.rm(nestedPath, { recursive: true, force: true });
  log(
    `Detected Next.js project inside subdirectory "${nestedName}". Contents moved to the project root.`
  );
}

async function waitForPreviewReady(
  url: string,
  log: (chunk: Buffer | string) => void,
  timeoutMs = 30_000,
  intervalMs = 1_000
) {
  const start = Date.now();
  let attempts = 0;

  // Per-attempt timeout so a hung connection can't block the readiness loop
  // beyond the overall budget.
  const fetchWithTimeout = (input: string, init?: RequestInit) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.min(intervalMs * 2, 5000));
    return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(t));
  };

  while (Date.now() - start < timeoutMs) {
    attempts += 1;
    try {
      const response = await fetchWithTimeout(url, { method: 'HEAD' });
      if (response.ok) {
        log(
          Buffer.from(
            `[PreviewManager] Preview server responded after ${attempts} attempt(s).`
          )
        );
        return true;
      }
      if (response.status === 405 || response.status === 501) {
        const getResponse = await fetchWithTimeout(url, { method: 'GET' });
        if (getResponse.ok) {
          log(
            Buffer.from(
              `[PreviewManager] Preview server responded to GET after ${attempts} attempt(s).`
            )
          );
          return true;
        }
      }
    } catch (error) {
      if (attempts === 1) {
        log(
          Buffer.from(
            `[PreviewManager] Waiting for preview server at ${url} (${error instanceof Error ? error.message : String(error)
            }).`
          )
        );
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  log(
    Buffer.from(
      `[PreviewManager] Preview server did not respond within ${timeoutMs}ms; continuing regardless.`
    )
  );
  return false;
}

async function appendCommandLogs(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logger: (chunk: Buffer | string) => void
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', logger);
    child.stderr?.on('data', logger);

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`${command} ${args.join(' ')} exited with code ${code}`)
        );
      }
    });
  });
}

async function ensureDependencies(
  projectPath: string,
  env: NodeJS.ProcessEnv,
  logger: (chunk: Buffer | string) => void
) {
  try {
    await fs.access(path.join(projectPath, 'node_modules'));
    return;
  } catch {
    // node_modules missing, fall back to npm install
  }

  await runInstallWithPreferredManager(projectPath, env, logger);
}

export interface PreviewInfo {
  port: number | null;
  url: string | null;
  status: PreviewStatus;
  logs: string[];
  pid?: number;
}

class PreviewManager {
  private processes = new Map<string, PreviewProcess>();
  private installing = new Map<string, Promise<void>>();
  // Serializes concurrent start() calls for the same project so two callers
  // can't both pass the "not running" check and spawn duplicate dev servers,
  // which would exhaust the preview port range and orphan processes.
  private starting = new Map<string, Promise<PreviewInfo>>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Periodically reclaim ports held by previews nobody is watching anymore.
    this.sweepTimer = setInterval(() => this.evictIdle(), PREVIEW_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
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

    await ensureProjectRootStructure(projectPath, record);

    try {
      await fs.access(path.join(projectPath, 'package.json'));
    } catch {
      const proj = await getProjectById(projectId).catch(() => null);
      const clean = scaffoldIsClean(proj?.templateType);
      record(`Bootstrapping ${clean ? 'clean' : 'starter'} Nuxt app for project ${projectId}`);
      await scaffoldBasicNextApp(projectPath, projectId, { clean });
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
    });
    this.starting.set(projectId, startPromise);
    return startPromise;
  }

  private async startInternal(projectId: string): Promise<PreviewInfo> {
    const project = await getProjectById(projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    const projectPath = project.repoPath
      ? path.resolve(project.repoPath)
      : path.join(process.cwd(), 'projects', projectId);

    await fs.mkdir(projectPath, { recursive: true });

    const pendingLogs: string[] = [];
    const queueLog = (message: string) => {
      const formatted = `[PreviewManager] ${message}`;
      console.log(formatted);
      pendingLogs.push(formatted);
    };

    await ensureProjectRootStructure(projectPath, queueLog);

    try {
      await fs.access(path.join(projectPath, 'package.json'));
    } catch {
      const proj = await getProjectById(projectId).catch(() => null);
      const clean = scaffoldIsClean(proj?.templateType);
      console.log(
        `[PreviewManager] Bootstrapping ${clean ? 'clean' : 'starter'} Nuxt app for project ${projectId}`
      );
      await scaffoldBasicNextApp(projectPath, projectId, { clean });
    }

    // Make the preview report its route to the URL bar (cross-origin iframe).
    await ensurePreviewRouteReporter(projectPath);

    const previewBounds = resolvePreviewBounds();
    let preferredPort: number;
    try {
      preferredPort = await findAvailablePort(previewBounds.start, previewBounds.end);
    } catch (poolFull) {
      // Pool exhausted — evict the least-recently-used preview to free a port,
      // then try once more.
      const victim = this.leastRecentlyUsed();
      if (!victim || victim === projectId) throw poolFull;
      console.log(`[PreviewManager] Port pool full; evicting LRU preview ${victim} to make room for ${projectId}`);
      await this.stop(victim).catch(() => {});
      preferredPort = await findAvailablePort(previewBounds.start, previewBounds.end);
    }

    // When Claudable runs remotely (e.g. on a server), localhost:<port> is not
    // reachable from the user's browser. PREVIEW_URL_TEMPLATE (e.g.
    // "https://preview-{port}.example.com") yields a publicly-routed URL instead.
    const buildPreviewUrl = (port: number): string => {
      const tmpl = process.env.PREVIEW_URL_TEMPLATE;
      if (tmpl && tmpl.includes('{port}')) {
        return tmpl.replace('{port}', String(port));
      }
      return `http://localhost:${port}`;
    };

    const initialUrl = buildPreviewUrl(preferredPort);

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

    // Ensure dependencies with the same per-project lock used by installDependencies
    const ensureWithLock = async () => {
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
    };

    await ensureWithLock();

    const packageJson = await readPackageJson(projectPath);
    const hasPredev = Boolean(packageJson?.scripts?.predev);

    if (hasPredev) {
      await appendCommandLogs(npmCommand, ['run', 'predev'], projectPath, env, log);
    }

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

    // Bind to all interfaces when hosting remotely so the reverse proxy can
    // reach the dev server (network_mode host -> proxy hits it via the gateway).
    const bindHost = process.env.PREVIEW_BIND_HOST;
    const devArgs = ['run', 'dev', '--', '--port', String(effectivePort)];
    if (bindHost && bindHost.trim().length > 0) {
      devArgs.push('--hostname', bindHost.trim());
    }

    const child = spawn(
      npmCommand,
      devArgs,
      {
        cwd: projectPath,
        env,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group so we can kill the WHOLE tree (npm -> sh -> nuxt).
        // Killing just the parent left the nuxt child holding the port, leaking
        // a dev server on every restart.
        detached: process.platform !== 'win32',
      }
    );

    previewProcess.process = child;
    this.processes.set(projectId, previewProcess);

    child.stdout?.on('data', (chunk) => {
      log(chunk);
      if (previewProcess.status === 'starting') {
        previewProcess.status = 'running';
      }
    });

    child.stderr?.on('data', (chunk) => {
      log(chunk);
    });

    child.on('exit', (code, signal) => {
      previewProcess.status = code === 0 ? 'stopped' : 'error';
      this.processes.delete(projectId);
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
      if (this.processes.get(projectId) === previewProcess) {
        this.processes.delete(projectId);
      }
      log(Buffer.from(`Preview process failed: ${error.message}`));
    });

    const ready = await waitForPreviewReady(previewProcess.url, log).catch(
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

    return this.toInfo(previewProcess);
  }

  public async stop(projectId: string): Promise<PreviewInfo> {
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
