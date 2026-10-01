/**
 * Builds a project's own Dockerfile (preview backends). RUN steps execute
 * project-controlled commands, so they must run on the egress-locked sandbox
 * network — internet yes, host / private ranges / cloud metadata no.
 *
 * Primary: BuildKit. A rootless buildkitd (compose service `buildkitd`) sits ON
 * the sandbox network, so every RUN step inherits its network namespace and the
 * sandbox firewall. Build-step root maps to an unprivileged host uid. Claudable
 * reaches it on host loopback (PREVIEW_BUILDKIT_HOST) via a `remote` buildx
 * builder and `--load`s the result into Docker through the socket proxy.
 *
 * Fallback: the legacy builder with `--network <sandbox>` (deprecated by Docker,
 * still the only builder that takes a custom network). Used only when BuildKit
 * is not configured or not reachable, and said so in the build log.
 */
import { spawn } from 'child_process';

export const BUILDER_NAME = 'claudable-sandbox';
const HEALTH_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;

export type BuildMode = 'buildkit' | 'legacy';

export interface BuildSpec {
  tag: string;
  dockerfile: string;
  /** Context path, or '-' for a tar on stdin. */
  context: string;
  sandboxNet?: string;
}

/** The docker CLI invocation for a build in the given mode. */
export function buildInvocation(mode: BuildMode, spec: BuildSpec): { args: string[]; env: Record<string, string> } {
  if (mode === 'buildkit') {
    return {
      args: ['buildx', 'build', '--builder', BUILDER_NAME, '--load', '--progress', 'plain', '-t', spec.tag, '-f', spec.dockerfile, spec.context],
      env: {},
    };
  }
  return {
    args: ['build', ...(spec.sandboxNet ? ['--network', spec.sandboxNet] : []), '-t', spec.tag, '-f', spec.dockerfile, spec.context],
    env: { DOCKER_BUILDKIT: '0' },
  };
}

export function buildkitHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const host = env.PREVIEW_BUILDKIT_HOST?.trim();
  return host && /^tcp:\/\/[\w.-]+:\d+$/u.test(host) ? host : null;
}

type Runner = (args: string[], timeoutMs: number) => Promise<{ code: number; out: string }>;

const runDocker: Runner = (args, timeoutMs) =>
  new Promise((resolve) => {
    let out = '';
    const p = spawn('docker', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout?.on('data', (d) => { out += d; });
    p.stderr?.on('data', (d) => { out += d; });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, out: String(e) }); });
  });

let cached: { mode: BuildMode; reason: string; at: number } | null = null;
let inflight: Promise<{ mode: BuildMode; reason: string }> | null = null;

/**
 * Which builder to use right now: BuildKit when configured and answering,
 * otherwise legacy. Creates the remote buildx builder on first use. Cached for a
 * minute; concurrent callers share one probe.
 */
export function selectBuilder(run: Runner = runDocker, now: () => number = Date.now): Promise<{ mode: BuildMode; reason: string }> {
  if (cached && now() - cached.at < HEALTH_TTL_MS) return Promise.resolve(cached);
  inflight ??= (async () => {
    const host = buildkitHost();
    if (!host) return { mode: 'legacy' as const, reason: 'PREVIEW_BUILDKIT_HOST not set' };
    const existing = await run(['buildx', 'inspect', BUILDER_NAME], PROBE_TIMEOUT_MS);
    if (existing.code !== 0 || !existing.out.includes(host)) {
      await run(['buildx', 'rm', BUILDER_NAME], PROBE_TIMEOUT_MS);
      const created = await run(['buildx', 'create', '--name', BUILDER_NAME, '--driver', 'remote', host], PROBE_TIMEOUT_MS);
      if (created.code !== 0) return { mode: 'legacy' as const, reason: `buildx create failed: ${created.out.trim().slice(0, 200)}` };
    }
    const probe = await run(['buildx', 'inspect', '--bootstrap', BUILDER_NAME], PROBE_TIMEOUT_MS);
    if (probe.code !== 0 || !/Status:\s+running/iu.test(probe.out)) {
      return { mode: 'legacy' as const, reason: `buildkitd at ${host} not reachable: ${probe.out.trim().slice(0, 200)}` };
    }
    return { mode: 'buildkit' as const, reason: `buildkitd at ${host}` };
  })()
    .then((r) => {
      cached = { ...r, at: now() };
      if (r.mode === 'legacy') console.warn(`[image-builder] using the legacy builder: ${r.reason}`);
      return r;
    })
    // Cleared here, never inside the async body: a body without an await finishes
    // synchronously, before `inflight ??=` assigns — that would leave a stale promise.
    .finally(() => { inflight = null; });
  return inflight;
}

/** Forget the cached choice (after a failed BuildKit build, re-probe next time). */
export function resetBuilderSelection(): void {
  cached = null;
}
