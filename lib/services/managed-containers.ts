/**
 * Per-project MANAGED CONTAINERS (composition step 3).
 *
 * A project can be composed with an ARBITRARY set of containers — 1, 2, 5, any
 * mix, any image — not a fixed frontend/backend/db triad. Each is a generic spec
 * (image + alias + env + optional persistent volume) that Claudable runs ON THAT
 * PROJECT'S OWN internal network (claudable-proj-<slug>) and NOTHING else:
 *  - NO host port is published → unreachable from the host or any other project;
 *    only this project's own containers (frontend / backend / agent), attached to
 *    the same internal net, reach it by its alias.
 *  - The project net is `--internal` (no gateway) → these containers have no
 *    egress at all, which is exactly what a database / cache wants.
 *  - Optional NAMED VOLUME (claudable-svc-<slug>-<id>-data) persists state.
 *
 * Nothing here is hardcoded to "database". Services come from either:
 *  - a TEMPLATE (lib/config/container-templates.ts — postgres/mysql/redis/…), which
 *    is pure data + a generated credential set, or
 *  - a fully CUSTOM spec (any image/alias/env/ports/volume the user provides).
 * Each service can declare `injectEnv` (e.g. DATABASE_URL / REDIS_URL) that is
 * merged into the app + agent automatically — so a new kind needs ZERO changes to
 * the preview/agent wiring.
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
import { getContainerTemplate, type ContainerTemplate, type SecretKind } from '@/lib/config/container-templates';

const PROVIDER = 'managed-containers';

/** A single container the project runs. `kind` is a free-form hint, not a type switch. */
export interface ManagedServiceSpec {
  id: string;                       // stable slug within the project: 'db', 'cache', 'worker'
  name: string;                     // display name
  image: string;                    // docker image
  alias?: string;                   // DNS alias on the project net (default = id)
  kind?: string;                    // 'database' | 'cache' | 'service' | … (hint only)
  templateId?: string;              // the template it came from, if any
  icon?: string;
  env?: Record<string, string>;     // NON-secret container env
  secretEnvEnc?: string;            // encrypted JSON blob of secret container env
  injectEnvEnc?: string;            // encrypted JSON blob of env to inject into the app/agent
  mountPath?: string;               // if set, a persistent named volume is mounted here
  healthCmd?: string;               // docker HEALTHCHECK (shell form) for readiness waits
  dependsOn?: string[];             // ids/aliases that must be healthy before this one starts
  memory?: string;                  // default 512m
  cpus?: string;                    // default 1.0
  ports?: number[];                 // container ports (informational; NOT host-published)
}

// Service kinds that OTHER services implicitly wait for (a DB/cache/… should be
// up + healthy before an app/worker that connects to it on startup). So "the app
// depends on the db" is ordered automatically, with no config. Includes common
// short aliases a custom container might use as its `kind` (db/redis/postgres/…).
const INFRA_KINDS = new Set([
  'database', 'cache', 'storage', 'search', 'queue', 'broker',
  'db', 'redis', 'postgres', 'postgresql', 'mysql', 'mariadb', 'mongo', 'mongodb', 'kv',
]);

/** Non-secret view for the UI / Network page. */
export interface ManagedServiceView {
  id: string; name: string; image: string; alias: string; kind: string;
  icon: string | null; mountPath: string | null; hasVolume: boolean; ports: number[];
  injectKeys: string[];             // names of the env vars this service exposes (no values)
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

// Keep stdout and stderr SEPARATE: parsers (inspect health/status) must read only
// stdout — a stray stderr warning folded into stdout would break `=== 'healthy'`
// and the `|`-split. Error messages read stderr; logs read both.
function docker(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const p = spawn('docker', args, { env: process.env });
    p.stdout?.on('data', (c) => { out += c.toString(); });
    p.stderr?.on('data', (c) => { err += c.toString(); });
    p.on('error', (e) => resolve({ ok: false, out, err: err || e.message }));
    p.on('exit', (code) => resolve({ ok: code === 0, out, err }));
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

// Serialize the read-modify-write of a project's spec list so two concurrent
// add/remove calls can't clobber each other (lost update). Per-project chain.
const specLocks = new Map<string, Promise<unknown>>();
function withSpecLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = specLocks.get(projectId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  specLocks.set(projectId, next.catch(() => {}));
  return next;
}

function decryptBlob(enc?: string): Record<string, string> {
  if (!enc) return {};
  try { return JSON.parse(decrypt(enc)) as Record<string, string>; } catch { return {}; }
}

/** Public (secret-free) view of the project's managed containers. */
export async function listServiceViews(projectId: string): Promise<ManagedServiceView[]> {
  return (await getServices(projectId)).map((s) => ({
    id: s.id,
    name: s.name,
    image: s.image,
    alias: s.alias || s.id,
    kind: s.kind || 'service',
    icon: s.icon || null,
    mountPath: s.mountPath || null,
    hasVolume: !!s.mountPath,
    ports: s.ports || [],
    injectKeys: Object.keys(decryptBlob(s.injectEnvEnc)),
  }));
}

/** Add (or replace by id) a managed container spec. Does NOT start it. */
export async function addService(projectId: string, spec: ManagedServiceSpec): Promise<void> {
  await withSpecLock(projectId, async () => {
    const services = await getServices(projectId);
    const next = services.filter((s) => s.id !== spec.id);
    next.push(spec);
    await saveServices(projectId, next);
  });
}

/** Remove a managed container (stops it; drops its volume only if asked). */
export async function removeService(
  projectId: string,
  id: string,
  opts: { deleteVolume?: boolean } = {},
): Promise<void> {
  await docker(['rm', '-f', serviceContainerName(projectId, id)]);
  if (opts.deleteVolume) await docker(['volume', 'rm', serviceVolumeName(projectId, id)]);
  await withSpecLock(projectId, async () => {
    await saveServices(projectId, (await getServices(projectId)).filter((s) => s.id !== id));
  });
}

// --- building specs: from a template, or fully custom ------------------------

/** A slug safe for an alias / a template-generated database name. */
function idSlug(s: string, max = 24): string {
  return (s.toLowerCase().replace(/[^a-z0-9]/gu, '_').replace(/_+/gu, '_').replace(/^_|_$/gu, '') || 'app').slice(0, max);
}
/** DNS-label alias (letters/digits/hyphen). */
function aliasSlug(s: string, max = 30): string {
  return (s.toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '') || 'svc').slice(0, max);
}

/** Generate the credential set a template asks for. */
function generateSecrets(kind: SecretKind, projectName: string): Record<string, string> {
  if (kind === 'none') return {};
  return { user: 'app', pass: randomBytes(18).toString('base64url'), db: idSlug(projectName) };
}

function applyTemplateVars(tmpl: Record<string, string> | undefined, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tmpl ?? {})) {
    out[k] = v.replace(/\{(\w+)\}/g, (_m, name) => (name in vars ? vars[name] : `{${name}}`));
  }
  return out;
}

/** Pick a value not already used, appending -2, -3, … (used for ids AND aliases). */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) { const c = `${base}-${i}`; if (!taken.has(c)) return c; }
}

/** Turn a template + a unique id/alias into a stored spec (generating creds). */
async function specFromTemplate(
  projectId: string, template: ContainerTemplate, id: string, alias: string,
): Promise<ManagedServiceSpec> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
  const secrets = generateSecrets(template.secrets || 'none', project?.name || projectId);
  const vars: Record<string, string> = { alias, port: String(template.port ?? ''), ...secrets };
  const containerEnv = applyTemplateVars(template.containerEnv, vars);
  const injectEnv = applyTemplateVars(template.injectEnv, vars);
  const healthCmd = template.healthCmd
    ? template.healthCmd.replace(/\{(\w+)\}/g, (_m, n) => (n in vars ? vars[n] : `{${n}}`))
    : undefined;
  return {
    id,
    name: template.name,
    image: template.image,
    alias,
    kind: template.kind,
    templateId: template.id,
    icon: template.icon,
    mountPath: template.mountPath,
    healthCmd,
    memory: template.memory,
    cpus: template.cpus,
    ports: template.port ? [template.port] : [],
    secretEnvEnc: Object.keys(containerEnv).length ? encrypt(JSON.stringify(containerEnv)) : undefined,
    injectEnvEnc: Object.keys(injectEnv).length ? encrypt(JSON.stringify(injectEnv)) : undefined,
  };
}

/** Add a service from a template (postgres/mysql/redis/…). Idempotent per id. */
export async function addServiceFromTemplate(
  projectId: string,
  templateId: string,
  opts: { id?: string } = {},
): Promise<ManagedServiceSpec> {
  const template = getContainerTemplate(templateId);
  if (!template) throw new Error(`Unknown container template: ${templateId}`);
  return withSpecLock(projectId, async () => {
    const services = await getServices(projectId);
    const id = opts.id || template.id;
    const existing = services.find((s) => s.id === id);
    if (existing) return existing;
    // Uniquify BOTH id and alias so two services never collide on either (e.g.
    // postgres + mysql both default to alias 'db').
    const uid = uniqueName(id, new Set(services.map((s) => s.id)));
    const alias = uniqueName(template.alias, new Set(services.map((s) => s.alias || s.id)));
    const spec = await specFromTemplate(projectId, template, uid, alias);
    const next = services.filter((s) => s.id !== spec.id);
    next.push(spec);
    await saveServices(projectId, next);
    return spec;
  });
}

export interface CustomServiceInput {
  name: string;
  image: string;
  alias?: string;
  kind?: string;
  env?: Record<string, string>;      // plain env (non-secret)
  injectEnv?: Record<string, string>; // env to inject into the app/agent
  mountPath?: string;
  ports?: number[];
  dependsOn?: string[];              // ids/aliases that must be healthy first
  memory?: string;
  cpus?: string;
}

/** Add a fully CUSTOM container (any image). No template, no generated secrets. */
export async function addCustomService(projectId: string, input: CustomServiceInput): Promise<ManagedServiceSpec> {
  const wantAlias = aliasSlug(input.alias || input.name);
  return withSpecLock(projectId, async () => {
    const services = await getServices(projectId);
    // Unique id AND alias so two custom services never collide on either.
    const id = uniqueName(wantAlias, new Set(services.map((s) => s.id)));
    const alias = uniqueName(wantAlias, new Set(services.map((s) => s.alias || s.id)));
    const spec: ManagedServiceSpec = {
      id,
      name: input.name || alias,
      image: input.image,
      alias,
      kind: input.kind || 'service',
      icon: '📦',
      env: input.env && Object.keys(input.env).length ? input.env : undefined,
      injectEnvEnc: input.injectEnv && Object.keys(input.injectEnv).length ? encrypt(JSON.stringify(input.injectEnv)) : undefined,
      mountPath: input.mountPath,
      dependsOn: input.dependsOn && input.dependsOn.length ? input.dependsOn : undefined,
      memory: input.memory,
      cpus: input.cpus,
      ports: input.ports || [],
    };
    const next = services.filter((s) => s.id !== spec.id);
    next.push(spec);
    await saveServices(projectId, next);
    return spec;
  });
}

// --- runtime -----------------------------------------------------------------

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
  if (spec.healthCmd) {
    // Docker runs this INSIDE the container (not via the denied `docker exec`), so
    // waitForServicesHealthy can poll .State.Health without EXEC on the proxy.
    args.push('--health-cmd', spec.healthCmd, '--health-interval', '2s',
      '--health-timeout', '3s', '--health-retries', '20', '--health-start-period', '2s');
  }
  const env = { ...(spec.env || {}), ...decryptBlob(spec.secretEnvEnc) };
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(spec.image);

  say(`starting ${spec.image} on ${net} (alias ${spec.alias || spec.id}, no host port)`);
  const run = await docker(args);
  if (!run.ok) { const msg = (run.err || run.out).trim(); say(`failed: ${msg.slice(-200)}`); throw new Error(`Managed container ${spec.id} failed: ${msg.slice(-160)}`); }
  return name;
}

/**
 * Order services into dependency LEVELS (each level can start in parallel; a
 * later level must wait for the earlier ones to be healthy). Edges come from an
 * explicit `dependsOn` (id or alias) PLUS the implicit rule "every non-infra
 * service depends on every infra service" (app → db/cache). Cycles/leftovers are
 * emitted as a final level so startup never hangs.
 */
export function orderServiceLevels(services: ManagedServiceSpec[]): ManagedServiceSpec[][] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const byAlias = new Map(services.map((s) => [s.alias || s.id, s]));
  const resolve = (ref: string): string | undefined => (byId.get(ref) || byAlias.get(ref))?.id;
  const infraIds = services.filter((s) => INFRA_KINDS.has(s.kind || '')).map((s) => s.id);

  const deps = new Map<string, Set<string>>();
  for (const s of services) {
    const d = new Set<string>();
    for (const ref of s.dependsOn ?? []) { const id = resolve(ref); if (id && id !== s.id) d.add(id); }
    if (!INFRA_KINDS.has(s.kind || '')) for (const iid of infraIds) if (iid !== s.id) d.add(iid);
    deps.set(s.id, d);
  }

  const done = new Set<string>();
  const levels: ManagedServiceSpec[][] = [];
  let remaining = services.map((s) => s.id);
  while (remaining.length) {
    const ready = remaining.filter((id) => [...deps.get(id)!].every((dep) => done.has(dep)));
    // No progress → a dependency cycle (or a dep on a missing service): start what's
    // left together rather than hang.
    const batch = ready.length ? ready : remaining;
    levels.push(batch.map((id) => byId.get(id)!));
    batch.forEach((id) => done.add(id));
    remaining = remaining.filter((id) => !done.has(id));
  }
  return levels;
}

/**
 * Start ALL of a project's managed containers on its internal network, in
 * DEPENDENCY ORDER: each level starts, then we wait for its health-checked
 * services to be ready before starting the next level. So a service that depends
 * on the DB (implicitly or via dependsOn) only starts once the DB accepts
 * connections — no crash-loop-until-restart.
 */
export async function startServices(projectId: string, log?: (line: string) => void): Promise<void> {
  const services = await getServices(projectId);
  if (!services.length) return;
  const net = await ensureProjectNetwork(projectId);
  const levels = orderServiceLevels(services);
  for (const level of levels) {
    for (const spec of level) {
      try { await startService(projectId, net, spec, log); }
      catch (e) { log?.(`[svc:${spec.id}] ${(e as Error).message}`); }
    }
    // Gate the next level on THIS level's readiness (only services with a
    // healthcheck actually block; app/worker services without one don't).
    await waitForServicesHealthy(projectId, 25_000, log, level.map((s) => s.id));
  }
}

/**
 * Wait until every service that declares a healthcheck reports `healthy` (or the
 * timeout elapses). Called before the app/agent use the services so a first
 * request/migration doesn't race a just-started Postgres. Best-effort: returns
 * after `timeoutMs` regardless (the app's own client retries cover the rest).
 */
export async function waitForServicesHealthy(
  projectId: string,
  timeoutMs = 25_000,
  log?: (line: string) => void,
  onlyIds?: string[],
): Promise<void> {
  const idSet = onlyIds ? new Set(onlyIds) : null;
  const withHealth = (await getServices(projectId))
    .filter((s) => s.healthCmd && (!idSet || idSet.has(s.id)));
  if (!withHealth.length) return;
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(withHealth.map((s) => s.id));
  while (pending.size && Date.now() < deadline) {
    for (const id of [...pending]) {
      const res = await docker(['inspect', serviceContainerName(projectId, id), '--format', '{{.State.Health.Status}}']);
      const status = res.out.trim();
      if (!res.ok || status === 'healthy' || status === '' || status === '<no value>') {
        // healthy, or no health info (container gone / no healthcheck) → stop waiting on it
        if (status === 'healthy') log?.(`[svc:${id}] healthy`);
        pending.delete(id);
      }
    }
    if (pending.size) await new Promise((r) => setTimeout(r, 500));
  }
  if (pending.size) log?.(`[svc] readiness timed out for: ${[...pending].join(', ')}`);
}

/** Stop all managed containers (keeps their volumes). */
export async function stopServices(projectId: string): Promise<void> {
  for (const spec of await getServices(projectId)) {
    await docker(['rm', '-f', serviceContainerName(projectId, spec.id)]);
  }
}

/**
 * Tear down ALL of a project's managed containers AND their volumes, and forget
 * the specs. Used on project deletion so a removed project leaves no orphaned DB
 * container / volume behind. Must run BEFORE the project row is deleted (it reads
 * the specs, which are cascade-deleted with the project).
 */
export async function removeAllServices(projectId: string): Promise<void> {
  for (const spec of await getServices(projectId)) {
    await docker(['rm', '-f', serviceContainerName(projectId, spec.id)]);
    await docker(['volume', 'rm', serviceVolumeName(projectId, spec.id)]);
  }
  try { await saveServices(projectId, []); } catch { /* row may already be gone */ }
}

/**
 * Ensure the project's managed containers are running — used by the AGENT turn so
 * the DB / cache is reachable at its alias even when no preview is active (e.g.
 * running a migration). Idempotent (skips already-running containers); a no-op for
 * projects with no managed containers.
 */
export async function ensureServicesRunning(projectId: string, log?: (line: string) => void): Promise<void> {
  await startServices(projectId, log);
  await waitForServicesHealthy(projectId, 25_000, log);
}

// --- lifecycle + observability (operate the containers) ----------------------

export interface ServiceRuntimeStatus {
  id: string;
  state: string;    // running / exited / restarting / created / '' (never started)
  status: string;   // human string ("Up 2 minutes", "Exited (1) 5s ago", …)
  running: boolean;
}

/** Live docker state for each of the project's managed containers. */
export async function serviceStatuses(projectId: string): Promise<Record<string, ServiceRuntimeStatus>> {
  const specs = await getServices(projectId);
  const out: Record<string, ServiceRuntimeStatus> = {};
  await Promise.all(specs.map(async (s) => {
    const name = serviceContainerName(projectId, s.id);
    const res = await docker(['inspect', name, '--format', '{{.State.Status}}|{{.State.Running}}|{{.State.Error}}']);
    if (!res.ok) { out[s.id] = { id: s.id, state: '', status: 'not started', running: false }; return; }
    const [state = '', running = 'false'] = res.out.trim().split('|');
    // A short human status via `docker ps` (Status column) for a nicer label.
    const ps = await docker(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Status}}']);
    out[s.id] = { id: s.id, state, status: ps.out.trim() || state, running: running === 'true' };
  }));
  return out;
}

/** Start / stop / restart a single managed container. `start` recreates if missing. */
export async function serviceAction(
  projectId: string,
  id: string,
  action: 'start' | 'stop' | 'restart',
): Promise<{ ok: boolean; out: string }> {
  const spec = (await getServices(projectId)).find((s) => s.id === id);
  if (!spec) return { ok: false, out: `Unknown service: ${id}` };
  const name = serviceContainerName(projectId, id);
  if (action === 'stop') return docker(['stop', name]);
  if (action === 'restart') {
    const r = await docker(['restart', name]);
    if (r.ok) return r;
    // No container to restart (never started / removed) → create it fresh.
    const net = await ensureProjectNetwork(projectId);
    try { await startService(projectId, net, spec); return { ok: true, out: 'created' }; }
    catch (e) { return { ok: false, out: (e as Error).message }; }
  }
  // start: try `docker start`, else create fresh on the project net.
  const started = await docker(['start', name]);
  if (started.ok) return started;
  const net = await ensureProjectNetwork(projectId);
  try { await startService(projectId, net, spec); return { ok: true, out: 'created' }; }
  catch (e) { return { ok: false, out: (e as Error).message }; }
}

/** Recent logs from a managed container (newest last). */
export async function serviceLogs(projectId: string, id: string, tail = 200): Promise<string> {
  const spec = (await getServices(projectId)).find((s) => s.id === id);
  if (!spec) return `Unknown service: ${id}`;
  const res = await docker(['logs', '--tail', String(Math.max(1, Math.min(tail, 1000))), serviceContainerName(projectId, id)]);
  // Container logs come on BOTH streams (app stdout + stderr) — show both.
  return [res.out, res.err].filter((s) => s.trim()).join('\n').trim() || '(no logs yet)';
}

// --- generic env injection ---------------------------------------------------

/**
 * The env every managed container exposes to the APP + agent, merged
 * (DATABASE_URL, REDIS_URL, MONGO_URL, custom vars…). Reachable because the app /
 * agent share the project's internal net. Generic: a new template that declares
 * `injectEnv` shows up here automatically.
 */
export async function getInjectedEnv(projectId: string): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const spec of await getServices(projectId)) {
    Object.assign(merged, decryptBlob(spec.injectEnvEnc));
  }
  return merged;
}

// --- convenience for the DB kind (used by the preview isolation gate) --------

/** Whether the project runs a per-project container database. */
export async function hasContainerDb(projectId: string): Promise<boolean> {
  return (await getServices(projectId)).some((s) => s.kind === 'database');
}

/** The internal DATABASE_URL this project's container DB exposes, or null. */
export async function getContainerDbUrl(projectId: string): Promise<string | null> {
  return (await getInjectedEnv(projectId)).DATABASE_URL || null;
}

/** Back-compat shim: add a Postgres container via the template. */
export async function ensurePostgresService(projectId: string): Promise<string> {
  await addServiceFromTemplate(projectId, 'postgres');
  return (await getContainerDbUrl(projectId)) || '';
}
