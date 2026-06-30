/**
 * Coolify operations for the it-ops broker.
 *
 * Runs IN the Claudable process — the agent never sees COOLIFY_API_TOKEN. Tools
 * are SCOPED to specific operations (list / restart / deploy / read+set env on a
 * named app), not a raw "call any Coolify endpoint" passthrough, so even with an
 * admin token the blast radius is bounded to these verbs.
 *
 * Config (env):
 *   COOLIFY_API_BASE   default http://localhost:8000  (Coolify on the same box)
 *   COOLIFY_API_TOKEN  generate in Coolify → Keys & Tokens → API tokens
 *
 * If COOLIFY_API_TOKEN is unset every op returns a "not configured" notice
 * instead of throwing, so the broker degrades gracefully until it's wired.
 */

import { fetchWithTimeout } from './net';

function base(): string {
  return (process.env.COOLIFY_API_BASE || 'http://localhost:8000').replace(/\/+$/u, '');
}

const enc = encodeURIComponent;
// Mask env values whose KEY looks secret, regardless of Coolify's is_secret flag
// (a secret added via the CLI/API may not be flagged) — never hand the agent creds.
const SECRET_KEY_RE = /TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL|PRIVATE|AUTH|DSN|DATABASE_URL/iu;

export function coolifyConfigured(): boolean {
  return !!(process.env.COOLIFY_API_TOKEN && process.env.COOLIFY_API_TOKEN.trim().length > 0);
}

class CoolifyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const token = process.env.COOLIFY_API_TOKEN?.trim();
  if (!token) throw new Error('Coolify not configured (set COOLIFY_API_TOKEN).');
  const res = await fetchWithTimeout(`${base()}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = await res.text();
  if (!res.ok) throw new CoolifyError(res.status, `Coolify ${res.status}: ${body.slice(0, 300)}`);
  return body.length ? JSON.parse(body) : null;
}

interface CoolifyApp {
  uuid: string;
  name: string;
  fqdn?: string | null;
  status?: string;
}

export async function listApps(): Promise<string> {
  const apps = (await api('/applications')) as CoolifyApp[];
  if (!apps?.length) return 'No Coolify applications.';
  return apps
    .map((a) => `- ${a.name} [${a.uuid}] status=${a.status ?? '?'}${a.fqdn ? ` fqdn=${a.fqdn}` : ''}`)
    .join('\n');
}

/** Resolve a name OR uuid to a uuid (name match is case-insensitive, exact). */
async function resolveUuid(nameOrUuid: string): Promise<{ uuid: string; name: string }> {
  const apps = (await api('/applications')) as CoolifyApp[];
  const byUuid = apps.find((a) => a.uuid === nameOrUuid);
  if (byUuid) return { uuid: byUuid.uuid, name: byUuid.name };
  const byName = apps.find((a) => a.name.toLowerCase() === nameOrUuid.toLowerCase());
  if (byName) return { uuid: byName.uuid, name: byName.name };
  throw new Error(`No Coolify app matching "${nameOrUuid}".`);
}

export async function restartApp(nameOrUuid: string): Promise<string> {
  const { uuid, name } = await resolveUuid(nameOrUuid);
  await api(`/applications/${enc(uuid)}/restart`, { method: 'POST' });
  return `Restart triggered for ${name} [${uuid}].`;
}

export async function deployApp(nameOrUuid: string): Promise<string> {
  const { uuid, name } = await resolveUuid(nameOrUuid);
  await api(`/deploy?uuid=${enc(uuid)}`);
  return `Deploy triggered for ${name} [${uuid}].`;
}

export async function getEnvs(nameOrUuid: string): Promise<string> {
  const { uuid, name } = await resolveUuid(nameOrUuid);
  const envs = (await api(`/applications/${enc(uuid)}/envs`)) as Array<{ key: string; value?: string; is_secret?: boolean }>;
  if (!envs?.length) return `${name}: no env vars.`;
  // Mask values flagged secret OR whose key looks secret — never echo creds.
  return `${name} env:\n${envs
    .map((e) => `  ${e.key}=${e.is_secret || SECRET_KEY_RE.test(e.key) ? '<secret>' : e.value ?? ''}`)
    .join('\n')}`;
}

export async function setEnv(nameOrUuid: string, key: string, value: string): Promise<string> {
  const { uuid, name } = await resolveUuid(nameOrUuid);
  const payload = JSON.stringify({ key, value, is_preview: false });
  // PATCH updates an existing key; only fall back to POST (create) on a genuine
  // 404 — catching ALL errors would create a DUPLICATE var on a transient 5xx
  // where the PATCH actually applied server-side.
  try {
    await api(`/applications/${enc(uuid)}/envs`, { method: 'PATCH', body: payload });
  } catch (e) {
    if (e instanceof CoolifyError && e.status === 404) {
      await api(`/applications/${enc(uuid)}/envs`, { method: 'POST', body: payload });
    } else {
      throw e;
    }
  }
  return `Set ${key} on ${name} [${uuid}] (redeploy for it to take effect).`;
}

// ---- Projects (top-level Coolify containers for environments/resources) ------

interface CoolifyProject {
  uuid: string;
  name: string;
  description?: string | null;
}

export async function listProjects(): Promise<string> {
  const projects = (await api('/projects')) as CoolifyProject[];
  if (!projects?.length) return 'No Coolify projects.';
  return projects.map((p) => `- ${p.name} [${p.uuid}]${p.description ? ` — ${p.description}` : ''}`).join('\n');
}

export async function createProject(name: string, description?: string): Promise<string> {
  const created = (await api('/projects', {
    method: 'POST',
    body: JSON.stringify({ name, ...(description ? { description } : {}) }),
  })) as { uuid: string };
  return `Created project "${name}" [${created.uuid}].`;
}

async function resolveProjectUuid(nameOrUuid: string): Promise<{ uuid: string; name: string }> {
  const projects = (await api('/projects')) as CoolifyProject[];
  const byUuid = projects.find((p) => p.uuid === nameOrUuid);
  if (byUuid) return { uuid: byUuid.uuid, name: byUuid.name };
  const byName = projects.find((p) => p.name.toLowerCase() === nameOrUuid.toLowerCase());
  if (byName) return { uuid: byName.uuid, name: byName.name };
  throw new Error(`No Coolify project matching "${nameOrUuid}".`);
}

/** Coolify refuses to delete a project that still holds resources (it must be empty). */
export async function deleteProject(nameOrUuid: string): Promise<string> {
  const { uuid, name } = await resolveProjectUuid(nameOrUuid);
  await api(`/projects/${enc(uuid)}`, { method: 'DELETE' });
  return `Deleted project "${name}" [${uuid}].`;
}
