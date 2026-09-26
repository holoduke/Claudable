// Docker helpers: orphan sweep, per-project internal networks, isolated backend containers, mtime scan.
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { previewSlug } from './routes';
import { appendCommandLogs } from './process-utils';
import type { PreviewBackendConfig } from './config';
import { realPathInside } from '@/lib/utils/safe-fs';
import { narrowContextPaths } from './build-context';

// Remove orphaned preview containers on boot. Claudable's process tracking is
// in-memory (reset on every restart/redeploy), so after a recreate each running
// claudable-preview-* container is an orphan still holding its host port. A fresh
// start would then collide on the port and the dev server "exits before reachable".
// Sweep them so boot starts from a clean slate. (a project's own sidecars, e.g. <slug>-api/-db, are named
// differently and are never matched.)
export async function sweepOrphanedPreviewContainers(
  keepContainers: Set<string> = new Set(),
  keepNetworks: Set<string> = new Set(),
): Promise<void> {
  // Exact names only: previews that were re-adopted after a restart (keep*) stay.
  const names = async (args: string[]) =>
    ((await dockerCapture(args, 15_000)) || '').split('\n').map((x) => x.trim()).filter(Boolean);
  try {
    for (const n of await names(['ps', '-a', '--filter', 'name=claudable-preview-', '--format', '{{.Names}}'])) {
      if (n.startsWith('claudable-preview-') && !keepContainers.has(n)) await dockerCapture(['rm', '-f', n], 30_000);
    }
    // Phase 2: orphaned agent-turn containers (their parent docker-CLI process
    // died with the old Claudable process; unnamed they would leak forever).
    for (const n of await names(['ps', '-a', '--filter', 'name=claudable-agent-', '--format', '{{.Names}}'])) {
      if (n.startsWith('claudable-agent-')) await dockerCapture(['rm', '-f', n], 30_000);
    }
    // Phase 1: also drop orphaned per-project networks (a network still in use fails harmlessly).
    for (const n of await names(['network', 'ls', '--filter', 'name=claudable-proj-', '--format', '{{.Name}}'])) {
      if (n.startsWith('claudable-proj-') && !keepNetworks.has(n)) await dockerCapture(['network', 'rm', n], 15_000);
    }
  } catch { /* best-effort */ }
}

/** Running preview containers with their published ports (for re-adoption after a restart). */
export async function runningPreviewContainers(): Promise<{ name: string; ports: string }[]> {
  const out = await dockerCapture(['ps', '--filter', 'name=claudable-preview-', '--format', '{{.Names}}\t{{.Ports}}'], 15_000);
  if (!out) return [];
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, ports = ''] = l.split('\t');
    return { name, ports };
  }).filter((c) => c.name.startsWith('claudable-preview-'));
}

/**
 * Pull images that previews/services need but the host doesn't have yet — in the
 * background, so the first preview after an image bump doesn't download inside its start.
 */
export async function prepullImages(images: string[]): Promise<void> {
  for (const image of [...new Set(images.filter((i) => /^[a-z0-9][a-z0-9./_:-]*$/i.test(i)))]) {
    if ((await dockerCapture(['image', 'inspect', '--format', '{{.Id}}', image], 15_000)) !== null) continue;
    console.log(`[PreviewManager] pre-pulling image ${image}`);
    const ok = (await dockerCapture(['pull', '--quiet', image], 15 * 60_000)) !== null;
    console.log(`[PreviewManager] pre-pull ${image}: ${ok ? 'done' : 'failed'}`);
  }
}

function dockerCapture(args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const p = spawn('docker', args, { env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const t = setTimeout(() => { p.kill('SIGKILL'); resolve(null); }, timeoutMs);
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => { clearTimeout(t); resolve(null); });
      p.on('exit', (code) => { clearTimeout(t); resolve(code === 0 ? out : null); });
    } catch {
      resolve(null);
    }
  });
}

/** Host ports in `docker ps --format {{.Ports}}` output ("10.0.1.1:3711->3711/tcp, …"). */
export function parsePublishedPorts(psPorts: string): Set<number> {
  const ports = new Set<number>();
  for (const m of psPorts.matchAll(/:(\d{1,5})(?:-(\d{1,5}))?->/g)) {
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    for (let p = from; p <= to && p - from < 1000; p += 1) ports.add(p);
  }
  return ports;
}

/**
 * Host ports published by ANY running container. Preview containers publish on the
 * gateway IP (10.0.1.1), which a loopback probe can't see — without this a running
 * preview's port looked free and was handed to another project (cross-project leak).
 */
export async function dockerPublishedPorts(): Promise<Set<number>> {
  const out = await dockerCapture(['ps', '--format', '{{.Ports}}']);
  return out === null ? new Set() : parsePublishedPorts(out);
}

/** True only if `container` is running AND publishes `port` on the host. */
export async function containerServesPort(container: string, port: number): Promise<boolean> {
  const out = await dockerCapture(['inspect', '-f', '{{.State.Running}} {{json .NetworkSettings.Ports}}', container]);
  if (!out) return false;
  const [running, ...rest] = out.trim().split(' ');
  if (running !== 'true') return false;
  return parsePublishedPorts(rest.join(' ').replace(/"HostPort":"(\d+)"/g, ':$1->')).has(port);
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
// egress-firewall changes needed (proven in production). The public URL is still injected
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

// --- Shared egress-locked SANDBOX network -----------------------------------
// The one external network every preview + agent container attaches to. It has
// vanished twice in prod (a `docker system prune` / `docker network prune`
// removing it while idle), which breaks ALL previews with "network
// claudable-sandbox not found". This recreates it (idempotently) so Claudable
// self-heals instead of needing a manual `docker network create`.
//
// IMPORTANT: the egress LOCK is host iptables (DOCKER-USER/INPUT DROP rules for
// the subnet) which this containerised process CANNOT set. Those rules are
// subnet-matched, so recreating with the SAME subnet re-applies the existing
// lock automatically. The authoritative owner of both the net AND the firewall
// is the host self-heal (/opt/claudable-sandbox-heal.sh via cron); this is the
// fast in-app backstop. The subnet MUST match that script's (default
// 172.31.99.0/24) — override both together via PREVIEW_SANDBOX_SUBNET.
let sandboxNetEnsured = false;
export async function ensureSandboxNetwork(force = false): Promise<void> {
  const name = process.env.PREVIEW_SANDBOX_NETWORK?.trim();
  if (!name) return; // isolation disabled — nothing to ensure
  if (sandboxNetEnsured && !force) return; // once per boot is enough on the hot path
  const exists = await dockerCli(['network', 'inspect', name]);
  if (!exists) {
    const subnet = process.env.PREVIEW_SANDBOX_SUBNET?.trim() || '172.31.99.0/24';
    const created = await dockerCli([
      'network', 'create', '--driver', 'bridge',
      '--subnet', subnet,
      '--opt', 'com.docker.network.bridge.enable_icc=false',
      name,
    ]);
    // eslint-disable-next-line no-console
    console.warn(
      created
        ? `[preview] recreated missing sandbox network '${name}' (${subnet}). ` +
          `Egress lock relies on host iptables for this subnet — ensure /opt/claudable-sandbox-heal.sh is active.`
        : `[preview] FAILED to recreate sandbox network '${name}'; previews will not start until it exists.`,
    );
  }
  sandboxNetEnsured = true;
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
  // `network rm` fails with "has active endpoints" while the just-stopped
  // frontend/backend containers are still detaching, leaking the per-project
  // network until the next boot sweep. Retry a few times so it usually cleans up
  // now. Best-effort throughout — the boot sweep is the backstop.
  const name = projectNetworkName(projectId);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await dockerCli(['network', 'rm', name])) return; // removed
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
  }
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
/**
 * Write container env vars to a PRIVATE (0600) env-file so their VALUES stay OFF
 * the `docker run` argv. argv is world-readable via /proc/<pid>/cmdline (and gets
 * echoed into command-failure logs), and these vars carry project secrets —
 * DATABASE_URL / REDIS_URL and the project's own Env-tab values. The docker CLI
 * reads --env-file client-side at launch, so the secrets travel to the daemon
 * over the API, never as process arguments. Returns the `--env-file <path>` args
 * (empty when there's nothing to write) + a cleanup that unlinks the file; the
 * caller runs cleanup once docker has launched (or on teardown). Mirrors the
 * env-file hardening already used for containerized agent turns.
 */
export function writeContainerEnvFile(
  env: Record<string, string>,
): { args: string[]; cleanup: () => void } {
  const entries = Object.entries(env);
  if (entries.length === 0) return { args: [], cleanup: () => {} };
  const filePath = path.join(os.tmpdir(), `claudable-cenv-${randomUUID().slice(0, 12)}`);
  // env-file is line-based KEY=VALUE; docker takes the value literally to EOL (no
  // quoting, no $-expansion). Strip newlines so a multi-line value can't smuggle
  // in extra vars; everything after the first '=' is the value.
  const body = entries.map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, ' ')}`).join('\n') + '\n';
  writeFileSync(filePath, body, { mode: 0o600 });
  return {
    args: ['--env-file', filePath],
    cleanup: () => { try { unlinkSync(filePath); } catch { /* already gone */ } },
  };
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

let gnuTar: Promise<boolean> | null = null;
/** The owner-normalising flags narrowBuildContext needs are GNU tar's (the Claudable image has it). */
function hasGnuTar(): Promise<boolean> {
  gnuTar ??= new Promise<boolean>((res) => {
    let out = '';
    const p = spawn('tar', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout?.on('data', (d) => { out += d; });
    p.on('close', () => res(/GNU tar/.test(out)));
    p.on('error', () => res(false));
  });
  return gnuTar;
}

/**
 * A minimal build context for this backend, or null to send the full context dir:
 * when the project has its own .dockerignore (docker applies it; we don't
 * re-implement it), when the Dockerfile lies outside the context, or when its
 * COPY/ADD sources aren't provably literal. Missing sources are left out so the
 * build fails exactly as it would with the full context.
 */
export async function narrowBuildContext(
  projectPath: string,
  c: NonNullable<PreviewBackendConfig['container']>,
): Promise<{ contextDir: string; dockerfile: string; paths: string[] } | null> {
  try {
    const contextDir = path.resolve(projectPath, c.context || '.');
    if (await fs.access(path.join(contextDir, '.dockerignore')).then(() => true, () => false)) return null;
    const dockerfileAbs = path.resolve(projectPath, c.dockerfile);
    const dockerfile = path.relative(contextDir, dockerfileAbs).split(path.sep).join('/');
    if (!dockerfile || dockerfile.startsWith('..') || path.isAbsolute(dockerfile)) return null;
    const paths = narrowContextPaths(await fs.readFile(dockerfileAbs, 'utf8'));
    if (!paths) return null;
    // tar follows symlinked PARENT dirs (docker's own context walk never does): every
    // parent must resolve inside the context, or a `backend -> /etc` link would pack
    // host files. The leaf itself is stored as-is (a symlink stays a symlink).
    const realContext = await fs.realpath(contextDir);
    const parentInside = async (rel: string) => {
      const parent = path.dirname(path.join(contextDir, rel));
      const real = await fs.realpath(parent).catch(() => null);
      return real !== null && (real === realContext || real.startsWith(realContext + path.sep));
    };
    if (!(await parentInside(dockerfile))) return null;
    const present: string[] = [];
    for (const p of paths) {
      if (!(await parentInside(p))) return null;
      if (await fs.lstat(path.join(contextDir, p)).then(() => true, () => false)) present.push(p);
    }
    // The Dockerfile must be in the tar once: skip it when a listed dir already holds it.
    const covered = present.some((p) => p === dockerfile || dockerfile.startsWith(p + '/'));
    return { contextDir, dockerfile, paths: covered ? present : [dockerfile, ...present] };
  } catch {
    return null;
  }
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

  // Defense in depth (config-policy.ts already enforces this): the Dockerfile
  // and build context must resolve inside the project — a context outside it
  // would ship other projects / Claudable's data dir to the build.
  for (const rel of [c.dockerfile, c.context || '.']) {
    if (typeof rel !== 'string' || path.isAbsolute(rel) || !(await realPathInside(projectPath, path.resolve(projectPath, rel)))) {
      throw new Error(`backend build refused: ${rel} is outside the project`);
    }
  }
  log(Buffer.from(`[PreviewManager] [backend] building image ${name} from ${c.dockerfile}…`));
  // RUN steps execute project-controlled commands: build on the egress-locked
  // sandbox network, never on the default bridge (which reaches the host's
  // services and private ranges).
  const buildNet = process.env.PREVIEW_SANDBOX_NETWORK?.trim();
  const buildFlags = [...(buildNet ? ['--network', buildNet] : []), '-t', name];
  const narrow = (await hasGnuTar()) ? await narrowBuildContext(projectPath, c) : null;
  if (narrow) {
    // Only the paths the Dockerfile COPYs (see build-context.ts) — same image, a
    // fraction of the upload. Paths go to tar as argv, never through a shell.
    log(Buffer.from(`[PreviewManager] [backend] build context narrowed to: ${narrow.paths.join(', ')}`));
    // Owner normalised to root like the docker CLI's own context tar — otherwise the
    // COPY cache keys (and the resulting image) differ from a full-context build.
    const tar = spawn('tar', ['-cf', '-', '--owner=0', '--group=0', '--numeric-owner', '-C', narrow.contextDir, '--', ...narrow.paths], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tarDone = new Promise<number>((res) => { tar.on('close', (code) => res(code ?? 1)); tar.on('error', () => res(1)); });
    tar.stderr?.on('data', log);
    await appendCommandLogs('docker', ['build', ...buildFlags, '-f', narrow.dockerfile, '-'], projectPath, dockerEnv, log, undefined, tar.stdout!);
    if ((await tarDone) !== 0) throw new Error('backend build context could not be packed');
  } else {
    await appendCommandLogs('docker', ['build', ...buildFlags, '-f', c.dockerfile, c.context || '.'], projectPath, dockerEnv, log);
  }

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
  // Project env (DATABASE_URL, the project's own secrets) via a 0600 env-file —
  // never as `-e` on the argv, which any host process can read via /proc and
  // which appendCommandLogs echoes into its failure message.
  const cenvFile = writeContainerEnvFile(containerEnv);
  runArgs.push(...cenvFile.args);
  runArgs.push(name); // image tag == container name

  log(Buffer.from(`[PreviewManager] [backend] starting container on 127.0.0.1:${hostPort} (mem ${c.memory || '512m'}, cpus ${c.cpus || '1.0'}, cap-drop ALL)`));
  try {
    await appendCommandLogs('docker', runArgs, projectPath, dockerEnv, log);
  } finally {
    cenvFile.cleanup(); // docker read the env-file client-side at launch
  }
  return name;
}
