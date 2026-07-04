/**
 * Per-project MANAGED CONTAINERS (composition step 3).
 *
 * A project can be composed with an ARBITRARY set of containers — 1, 2, 5, any
 * mix — not a fixed frontend/backend/db triad. Each is a generic spec (image +
 * alias + env + optional persistent volume) that Claudable runs ON THAT
 * PROJECT'S OWN internal network (claudable-proj-<slug>) and NOTHING else:
 *  - NO host port is published → a managed container is unreachable from the
 *    host or any other project; only this project's own containers (frontend /
 *    backend / agent), attached to the same internal net, reach it by its alias.
 *  - The project net is `--internal` (no gateway) → these containers have no
 *    egress at all, which is exactly what a database/cache wants.
 *  - Optional NAMED VOLUME (claudable-svc-<slug>-<id>-data) persists state across
 *    restarts/redeploys.
 *
 * The DATABASE is just the first well-known KIND built on this model (a postgres
 * image + a volume + generated creds exposed as DATABASE_URL). New kinds (cache,
 * queue, search, a bespoke image) are added the same way — no hardcoded types.
 *
 * Talks to Docker via DOCKER_HOST (the socket-proxy), never the raw socket. The
 * AGENT never calls this (no docker access); only Claudable's control plane does.
 */
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { encrypt, decrypt } from '@/lib/crypto';
import { getProjectService, upsertProjectServiceConnection } from '@/lib/services/project-services';
import { prisma } from '@/lib/db/client';
import { previewSlug, ensureProjectNetwork } from './preview';

const PROVIDER = 'managed-containers';

/** A single container the project runs. `kind` is a free-form hint, not a type switch. */
export interface ManagedServiceSpec {
  id: string;                       // stable slug within the project: 'db', 'cache', 'worker'
  name: string;                     // display name
  image: string;                    // docker image
  alias?: string;                   // DNS alias on the project net (default = id)
  kind?: string;                    // 'database' | 'cache' | 'service' | … (hint only)
  env?: Record<string, string>;     // NON-secret env
  secretEnvEnc?: string;            // encrypted JSON blob of secret env (e.g. DB password)
  mountPath?: string;               // if set, a persistent named volume is mounted here
  memory?: string;                  // default 512m
  cpus?: string;                    // default 1.0
  ports?: number[];                 // container ports (informational; NOT host-published)
}

/** Non-secret view for the UI / Network page. */
export interface ManagedServiceView {
  id: string; name: string; image: string; alias: string; kind: string;
  mountPath: string | null; hasVolume: boolean; ports: number[];
}

export function serviceContainerName(projectId: string, id: string): string {
  return `claudable-svc-${previewSlug(projectId)}-${id}`;
}
export function serviceVolumeName(projectId: string, id: string): string {
  return `claudable-svc-${previewSlug(projectId)}-${id}-data`;
}
export function managedContainersEnabled(): boolean {
  return !!(process.env.PREVIEW_ISOLATION && process.env.PREVIEW_ISOLATION.trim());
}

function docker(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('docker', args, { env: process.env });
    p.stdout?.on('data', (c) => { out += c.toString(); });
    p.stderr?.on('data', (c) => { out += c.toString(); });
    p.on('error', () => resolve({ ok: false, out }));
    p.on('exit', (code) => resolve({ ok: code === 0, out }));
  });
}

// --- persistence: the spec list lives in a ProjectServiceConnection ----------

export async function getServices(projectId: string): Promise<ManagedServiceSpec[]> {
  const svc = await getProjectService(projectId, PROVIDER);
  const list = (svc?.serviceData as { services?: unknown } | undefined)?.services;
  return Array.isArray(list) ? (list as ManagedServiceSpec[]) : [];
}
async function saveServices(projectId: string, services: ManagedServiceSpec[]): Promise<void> {
  await upsertProjectServiceConnection(projectId, PROVIDER, { services });
}

/** Public (secret-free) view of the project's managed containers. */
export async function listServiceViews(projectId: string): Promise<ManagedServiceView[]> {
  return (await getServices(projectId)).map((s) => ({
    id: s.id,
    name: s.name,
    image: s.image,
    alias: s.alias || s.id,
    kind: s.kind || 'service',
    mountPath: s.mountPath || null,
    hasVolume: !!s.mountPath,
    ports: s.ports || [],
  }));
}

/** Add (or replace by id) a managed container spec. Does NOT start it. */
export async function addService(projectId: string, spec: ManagedServiceSpec): Promise<void> {
  const services = await getServices(projectId);
  const next = services.filter((s) => s.id !== spec.id);
  next.push(spec);
  await saveServices(projectId, next);
}

/** Remove a managed container (stops it; drops its volume only if asked). */
export async function removeService(
  projectId: string,
  id: string,
  opts: { deleteVolume?: boolean } = {},
): Promise<void> {
  await docker(['rm', '-f', serviceContainerName(projectId, id)]);
  if (opts.deleteVolume) await docker(['volume', 'rm', serviceVolumeName(projectId, id)]);
  await saveServices(projectId, (await getServices(projectId)).filter((s) => s.id !== id));
}

// --- runtime -----------------------------------------------------------------

function decryptSecretEnv(spec: ManagedServiceSpec): Record<string, string> {
  if (!spec.secretEnvEnc) return {};
  try { return JSON.parse(decrypt(spec.secretEnvEnc)) as Record<string, string>; }
  catch { return {}; }
}

/** Start one managed container on the project net (idempotent). Returns its name. */
async function startService(
  projectId: string,
  net: string,
  spec: ManagedServiceSpec,
  log?: (line: string) => void,
): Promise<string> {
  const name = serviceContainerName(projectId, spec.id);
  const say = (m: string) => log?.(`[svc:${spec.id}] ${m}`);

  const running = await docker(['ps', '--filter', `name=^${name}$`, '--filter', 'status=running', '--format', '{{.Names}}']);
  if (running.ok && running.out.trim() === name) { say('already running'); return name; }

  await docker(['rm', '-f', name]); // clear a stale stopped container; the VOLUME persists
  const args = [
    'run', '-d', '--name', name,
    '--network', net,
    '--network-alias', spec.alias || spec.id,
    // NO `-p` → not host-published; reachable ONLY from co-attached project containers.
    '--memory', spec.memory || '512m',
    '--cpus', String(spec.cpus || '1.0'),
    '--pids-limit', '512',
    '--security-opt', 'no-new-privileges',
    '--restart', 'unless-stopped',
  ];
  if (spec.mountPath) {
    const vol = serviceVolumeName(projectId, spec.id);
    await docker(['volume', 'create', vol]);
    args.push('-v', `${vol}:${spec.mountPath}`);
  }
  const env = { ...(spec.env || {}), ...decryptSecretEnv(spec) };
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(spec.image);

  say(`starting ${spec.image} on ${net} (alias ${spec.alias || spec.id}, no host port)`);
  const run = await docker(args);
  if (!run.ok) { say(`failed: ${run.out.trim().slice(-200)}`); throw new Error(`Managed container ${spec.id} failed: ${run.out.trim().slice(-160)}`); }
  return name;
}

/** Start ALL of a project's managed containers on its internal network. */
export async function startServices(projectId: string, log?: (line: string) => void): Promise<void> {
  const services = await getServices(projectId);
  if (!services.length) return;
  const net = await ensureProjectNetwork(projectId);
  for (const spec of services) {
    try { await startService(projectId, net, spec, log); }
    catch (e) { log?.(`[svc:${spec.id}] ${(e as Error).message}`); }
  }
}

/** Stop all managed containers (keeps their volumes). */
export async function stopServices(projectId: string): Promise<void> {
  for (const spec of await getServices(projectId)) {
    await docker(['rm', '-f', serviceContainerName(projectId, spec.id)]);
  }
}

// --- the DATABASE kind (first well-known kind) -------------------------------

const PG_IMAGE = process.env.PREVIEW_DB_IMAGE || 'pgvector/pgvector:pg16';
const PG_PORT = 5432;

function dbNameSlug(s: string): string {
  return (s.toLowerCase().replace(/[^a-z0-9]/gu, '_').replace(/_+/gu, '_').replace(/^_|_$/gu, '') || 'app').slice(0, 24);
}

/**
 * Ensure the project has a Postgres managed container (kind 'database', alias
 * 'db'). Generates credentials ONCE, stores them encrypted in the spec, and
 * returns the internal DATABASE_URL (postgresql://…@db:5432/…). Idempotent.
 */
export async function ensurePostgresService(projectId: string): Promise<string> {
  const existing = (await getServices(projectId)).find((s) => s.kind === 'database');
  if (existing) {
    const url = getDbUrlFromSpec(existing);
    if (url) return url;
  }
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
  const user = 'app';
  const password = randomBytes(18).toString('base64url');
  const database = dbNameSlug(project?.name || projectId);
  const spec: ManagedServiceSpec = {
    id: 'db',
    name: 'Database',
    image: PG_IMAGE,
    alias: 'db',
    kind: 'database',
    mountPath: '/var/lib/postgresql/data',
    memory: process.env.PREVIEW_DB_MEMORY || '512m',
    cpus: process.env.PREVIEW_DB_CPUS || '1.0',
    ports: [PG_PORT],
    secretEnvEnc: encrypt(JSON.stringify({
      POSTGRES_USER: user,
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: database,
    })),
  };
  await addService(projectId, spec);
  return `postgresql://${user}:${password}@db:${PG_PORT}/${database}`;
}

function getDbUrlFromSpec(spec: ManagedServiceSpec): string | null {
  const env = decryptSecretEnv(spec);
  if (!env.POSTGRES_USER || !env.POSTGRES_PASSWORD || !env.POSTGRES_DB) return null;
  const alias = spec.alias || 'db';
  return `postgresql://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@${alias}:${PG_PORT}/${env.POSTGRES_DB}`;
}

/** The internal DATABASE_URL for this project's container DB, or null. */
export async function getContainerDbUrl(projectId: string): Promise<string | null> {
  const spec = (await getServices(projectId)).find((s) => s.kind === 'database');
  return spec ? getDbUrlFromSpec(spec) : null;
}

/** Whether the project runs a per-project container database. */
export async function hasContainerDb(projectId: string): Promise<boolean> {
  return (await getServices(projectId)).some((s) => s.kind === 'database');
}
