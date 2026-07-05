// Docker helpers: orphan sweep, per-project internal networks, isolated backend containers, mtime scan.
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { previewSlug } from './routes';
import { appendCommandLogs } from './process-utils';
import type { PreviewBackendConfig } from './config';

// Remove orphaned preview containers on boot. Claudable's process tracking is
// in-memory (reset on every restart/redeploy), so after a recreate each running
// claudable-preview-* container is an orphan still holding its host port. A fresh
// start would then collide on the port and the dev server "exits before reachable".
// Sweep them so boot starts from a clean slate. (storyloop-api/db etc. are named
// differently and are never matched.)
export async function sweepOrphanedPreviewContainers(): Promise<void> {
  try {
    await new Promise<void>((res) => {
      const p = spawn('sh', ['-c',
        'ids=$(docker ps -aq --filter name=claudable-preview-); [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1; ' +
        // Phase 2: orphaned agent-turn containers (their parent docker-CLI process
        // died with the old Claudable process; unnamed they would leak forever).
        'ids=$(docker ps -aq --filter name=claudable-agent-); [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1; ' +
        // Phase 1: also drop orphaned per-project networks (safe once their containers are gone).
        'for n in $(docker network ls --filter name=claudable-proj- --format "{{.Name}}"); do docker network rm "$n" >/dev/null 2>&1; done; true'],
        { env: process.env, stdio: 'ignore' });
      p.on('exit', () => res());
      p.on('error', () => res());
    });
  } catch { /* best-effort */ }
}

// A composed/sidecar backend's published port is derived from the frontend port
// (no second pool slot). Guard the derivation: a widened PREVIEW_PORT range must
// never produce a port past 65535 (docker -p would fail) — return null so the
// caller skips the backend instead of crashing the whole preview start.
export const BACKEND_PORT_OFFSET = 5000;
export function deriveBackendPort(frontendPort: number): number | null {
  const p = frontendPort + BACKEND_PORT_OFFSET;
  return p >= 1024 && p <= 65535 ? p : null;
}

/** Whether isolated (containerised) backends are enabled for this deployment. */
export function isolationEnabled(): boolean {
  return !!(process.env.PREVIEW_ISOLATION && process.env.PREVIEW_ISOLATION.trim());
}
export function backendContainerName(projectId: string): string {
  return `claudable-preview-${previewSlug(projectId)}`;
}
/** Fire-and-forget removal of an isolated container (backend or frontend). */
export function removeBackendContainer(name: string | null | undefined): void {
  if (!name) return;
  try {
    const p = spawn('sh', ['-c', `docker rm -f ${name} 2>/dev/null || true`], { env: process.env, stdio: 'ignore', detached: true });
    p.unref();
  } catch { /* best-effort */ }
}
/** Blocking container removal — used before (re)creating a container by name. */
export async function dockerRmSync(name: string): Promise<void> {
  await new Promise<void>((res) => {
    const p = spawn('sh', ['-c', `docker rm -f ${name} 2>/dev/null || true`], { env: process.env, stdio: 'ignore' });
    p.on('exit', () => res());
    p.on('error', () => res());
  });
}

// --- Per-project INTERNAL network (Phase 1: direct fe↔be comms) -------------
// Each composed project gets a `docker --internal` network (no gateway → no egress
// via it; icc on). Service containers stay on the egress-locked SANDBOX net (for
// firewalled internet) AND join this net, so they reach each other DIRECTLY by an
// internal-only ALIAS (e.g. http://api:8080) while egress stays locked — no
// egress-firewall changes needed (proven on box1). The public URL is still injected
// for browser calls; the internal URL is for server-side/SSR/proxy hops.
function projectNetworkName(projectId: string): string {
  return `claudable-proj-${previewSlug(projectId)}`;
}
async function dockerCli(args: string[]): Promise<boolean> {
  return new Promise<boolean>((res) => {
    const p = spawn('docker', args, { env: process.env, stdio: 'ignore' });
    p.on('exit', (code) => res(code === 0));
    p.on('error', () => res(false));
  });
}
export async function ensureProjectNetwork(projectId: string): Promise<string> {
  const name = projectNetworkName(projectId);
  await dockerCli(['network', 'create', '--internal', name]); // no-op if it already exists
  return name;
}
/** Join a container to the project net (container may not be running yet → retry). */
export async function connectToProjectNet(net: string, container: string, alias?: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const args = ['network', 'connect', ...(alias ? ['--alias', alias] : []), net, container];
    if (await dockerCli(args)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}
export async function removeProjectNetwork(projectId: string): Promise<void> {
  await dockerCli(['network', 'rm', projectNetworkName(projectId)]);
}

// Skip generated/dependency dirs when scanning a backend's source for changes —
// their mtimes churn (build output, vendored deps) and would trigger needless rebuilds.
const MTIME_SKIP_DIRS = new Set(['node_modules', 'vendor', 'bin', 'tmp', '.git', 'target', '__pycache__', '.venv', 'dist', 'build']);
/** Newest file mtime (ms) anywhere under `dir`, skipping build/dep dirs. 0 if none. */
export async function latestMtimeMs(dir: string, depth = 0): Promise<number> {
  if (depth > 8) return 0;
  let newest = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.claudable') continue;
    if (e.isDirectory()) {
      if (MTIME_SKIP_DIRS.has(e.name)) continue;
      newest = Math.max(newest, await latestMtimeMs(path.join(dir, e.name), depth + 1));
    } else if (e.isFile()) {
      try { newest = Math.max(newest, (await fs.stat(path.join(dir, e.name))).mtimeMs); } catch { /* skip */ }
    }
  }
  return newest;
}
/** Translate a container path under /app/data to its real host path (for Docker
 *  bind mounts, which the daemon resolves on the HOST). DATA_HOST_DIR is the host
 *  path that the compose mounts at /app/data. */
export function toHostPath(p: string): string {
  const hostData = process.env.DATA_HOST_DIR;
  if (hostData && hostData.trim() && p.startsWith('/app/data')) {
    return path.join(hostData.trim(), path.relative('/app/data', p));
  }
  return p;
}

/**
 * Build the project's own Dockerfile and run the backend in a HARDENED sibling
 * container (non-root by the image's own USER, cap-drop ALL, no-new-privileges,
 * memory/cpu/pid limits, isolated network with only the backend port published
 * to loopback, and NONE of Claudable's env). Returns the container name.
 * Talks to Docker via DOCKER_HOST (the locked-down socket-proxy), never the raw
 * socket. `containerEnv` is the ONLY env the container gets.
 */
export async function runBackendContainer(
  projectId: string,
  projectPath: string,
  c: NonNullable<PreviewBackendConfig['container']>,
  hostPort: number,
  containerEnv: Record<string, string>,
  log: (chunk: string | Buffer) => void,
  publishHost: string = '127.0.0.1',
  containerName?: string,
): Promise<string> {
  const name = containerName || backendContainerName(projectId);
  const dockerEnv = process.env; // the CLI needs DOCKER_HOST + PATH

  log(Buffer.from(`[PreviewManager] [backend] building image ${name} from ${c.dockerfile}…`));
  await appendCommandLogs('docker', ['build', '-f', c.dockerfile, '-t', name, c.context || '.'], projectPath, dockerEnv, log);

  // Clear any stale container from a previous start (ignore "no such container").
  await new Promise<void>((res) => {
    const p = spawn('sh', ['-c', `docker rm -f ${name} 2>/dev/null || true`], { cwd: projectPath, env: dockerEnv, stdio: 'ignore' });
    p.on('exit', () => res());
    p.on('error', () => res());
  });

  const runArgs = [
    'run', '-d', '--name', name,
    '-p', `${publishHost}:${hostPort}:${c.port}`,
    '--memory', c.memory || '512m',
    '--cpus', String(c.cpus || '1.0'),
    '--pids-limit', String(c.pidsLimit ?? 256),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--restart', 'no',
  ];
  if (c.dev) {
    // Dev/watch mode: bind-mount the backend source so the in-container watcher
    // (air / node --watch / uvicorn --reload) hot-reloads on the agent's edits,
    // and run as uid 1000 to match the host files (writable for node_modules /
    // air-tmp) — non-root. Falls back to a full rebuild-on-restart if omitted.
    const hostSrc = toHostPath(path.join(projectPath, c.watchDir || 'backend'));
    runArgs.push('--user', '1000:1000', '-v', `${hostSrc}:/app`, '-w', '/app');
  }
  // Egress-locked sandbox network: reaches the public internet (for the app's own
  // API calls) but NOT the box's private ranges — host, Claudable, DBs, other
  // previews, cloud metadata (enforced by DOCKER-USER + INPUT firewall rules).
  const sandboxNet = process.env.PREVIEW_SANDBOX_NETWORK;
  if (sandboxNet && sandboxNet.trim()) runArgs.push('--network', sandboxNet.trim());
  for (const [k, v] of Object.entries(containerEnv)) runArgs.push('-e', `${k}=${v}`);
  runArgs.push(name); // image tag == container name

  log(Buffer.from(`[PreviewManager] [backend] starting container on 127.0.0.1:${hostPort} (mem ${c.memory || '512m'}, cpus ${c.cpus || '1.0'}, cap-drop ALL)`));
  await appendCommandLogs('docker', runArgs, projectPath, dockerEnv, log);
  return name;
}
