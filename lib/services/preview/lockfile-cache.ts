// Faster first installs: a shared npm cache + pre-resolved lockfiles for the scaffold templates.
//
// A freshly scaffolded project has no package-lock.json, so its first `npm install` must
// resolve the whole dependency tree (~750 packages for the Nuxt starter) against the
// registry: ~40 s. With a lockfile the same install takes ~5 s from a warm cache.
//
// SECURITY: lockfiles are shared ACROSS projects, so only lockfiles Claudable generates
// ITSELF — from its own template package.json, in a private temp dir — are cached. A
// project's own lockfile (written by the agent or a customer) is never cached, so one
// project can't plant resolved URLs/integrities into another. Every seeded lockfile must
// also resolve exclusively from the public npm registry.
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { appendCommandLogs } from './process-utils';

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_ROOT = path.isAbsolute(PROJECTS_DIR) ? PROJECTS_DIR : path.resolve(process.cwd(), PROJECTS_DIR);
const DATA_ROOT = path.resolve(PROJECTS_ROOT, '..');
const LOCK_CACHE_DIR = path.join(DATA_ROOT, '.lock-cache');
const REGISTRY = 'https://registry.npmjs.org/';
const MAX_LOCK_BYTES = 20 * 1024 * 1024;
const OTHER_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json'];

/**
 * The shared, persistent npm cache (under the data volume — survives Claudable redeploys).
 * Same directory the isolated preview containers mount as /npm-cache.
 */
export function sharedNpmCacheDir(): string {
  return path.join(DATA_ROOT, '.npm-cache');
}

/**
 * Env for any npm run in the Claudable process: shared cache, no audit/fund noise.
 * Deliberately NOT prefer-offline: with a long-lived shared cache npm would trust stale
 * registry metadata and fail (ETARGET) on versions published after it was cached.
 */
export function npmInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    npm_config_cache: sharedNpmCacheDir(),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

type Pkg = Record<string, unknown>;

/** Cache key: only the fields that determine the resolved tree (never name/version/scripts). */
export function depsKey(pkg: Pkg): string {
  const pick = (k: string) => {
    const v = pkg[k];
    if (!v || typeof v !== 'object') return null;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  };
  const material = JSON.stringify({
    dependencies: pick('dependencies'),
    devDependencies: pick('devDependencies'),
    optionalDependencies: pick('optionalDependencies'),
    peerDependencies: pick('peerDependencies'),
    overrides: pick('overrides'),
    workspaces: pkg.workspaces ?? null,
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** A lockfile is only acceptable if every package resolves from the public npm registry. */
export function lockResolvesOnlyFromRegistry(lock: { packages?: Record<string, { resolved?: string }> }): boolean {
  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') return false;
  for (const entry of Object.values(lock.packages)) {
    if (entry && typeof entry.resolved === 'string' && !entry.resolved.startsWith(REGISTRY)) return false;
  }
  return true;
}

async function readJson(file: string): Promise<any | null> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_LOCK_BYTES) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

/**
 * Before a project's first install: if it has no lockfile yet and a trusted template
 * lockfile exists for exactly its dependency set, write it (with the project's own
 * name/version). Returns true when a lockfile was seeded.
 */
export async function seedLockfile(projectPath: string, log?: (msg: string) => void): Promise<boolean> {
  try {
    if (await exists(path.join(projectPath, 'package-lock.json'))) return false;
    for (const f of OTHER_LOCKFILES) if (await exists(path.join(projectPath, f))) return false;
    if (await exists(path.join(projectPath, 'node_modules'))) return false;
    const pkg = await readJson(path.join(projectPath, 'package.json'));
    if (!pkg) return false;
    const lock = await readJson(path.join(LOCK_CACHE_DIR, `${depsKey(pkg)}.json`));
    if (!lock || !lockResolvesOnlyFromRegistry(lock)) return false;
    lock.name = pkg.name;
    lock.version = pkg.version;
    if (lock.packages?.['']) {
      lock.packages[''].name = pkg.name;
      lock.packages[''].version = pkg.version;
    }
    // exclusive create: never overwrite a lockfile that appeared meanwhile
    await fs.writeFile(path.join(projectPath, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
    log?.('Using a pre-resolved lockfile for this template (fast install).');
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve (not install) the lockfile of each npm scaffold template in a private temp dir
 * and cache it. Runs in the background at boot; only fetches registry metadata the
 * shared cache doesn't have yet. Safe to call repeatedly (skips cached keys).
 */
export async function prewarmTemplateLockfiles(): Promise<void> {
  const { STACKS, stackKind } = await import('@/lib/config/stacks');
  const { scaffoldForStack } = await import('@/lib/utils/scaffold-dispatch');
  await fs.mkdir(LOCK_CACHE_DIR, { recursive: true });
  for (const stack of STACKS) {
    const kind = stackKind(stack.id);
    if (kind === 'static' || kind === 'laravel') continue;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claudable-lock-'));
    try {
      await scaffoldForStack(tmp, 'lockwarm', stack.id, 'lockwarm');
      const pkg = await readJson(path.join(tmp, 'package.json'));
      if (!pkg) continue;
      const target = path.join(LOCK_CACHE_DIR, `${depsKey(pkg)}.json`);
      if (await exists(target)) continue;
      await appendCommandLogs(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['install', '--package-lock-only', '--ignore-scripts'],
        tmp,
        npmInstallEnv(process.env),
        () => {},
      );
      const lock = await readJson(path.join(tmp, 'package-lock.json'));
      if (lock && lockResolvesOnlyFromRegistry(lock)) {
        await fs.writeFile(`${target}.tmp`, JSON.stringify(lock), 'utf8');
        await fs.rename(`${target}.tmp`, target);
        console.log(`[PreviewManager] cached template lockfile for stack "${stack.id}"`);
      }
    } catch (error) {
      console.warn(`[PreviewManager] lockfile prewarm for "${stack.id}" failed:`, error instanceof Error ? error.message : error);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
}
