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

function base(): string {
  return (process.env.COOLIFY_API_BASE || 'http://localhost:8000').replace(/\/+$/u, '');
}

export function coolifyConfigured(): boolean {
  return !!(process.env.COOLIFY_API_TOKEN && process.env.COOLIFY_API_TOKEN.trim().length > 0);
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const token = process.env.COOLIFY_API_TOKEN?.trim();
  if (!token) throw new Error('Coolify not configured (set COOLIFY_API_TOKEN).');
  const res = await fetch(`${base()}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Coolify ${res.status}: ${body.slice(0, 300)}`);
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
  await api(`/applications/${uuid}/restart`, { method: 'POST' });
  return `Restart triggered for ${name} [${uuid}].`;
}

export async function deployApp(nameOrUuid: string): Promise<string> {
  const { uuid, name } = await resolveUuid(nameOrUuid);
  await api(`/deploy?uuid=${encodeURIComponent(uuid)}`);
  return `Deploy triggered for ${name} [${uuid}].`;
}

export async function getEnvs(nameOrUuid: string): Promise<string> {
  const { uuid, name } = await resolveUuid(nameOrUuid);
  const envs = (await api(`/applications/${uuid}/envs`)) as Array<{ key: string; value?: string; is_secret?: boolean }>;
  if (!envs?.length) return `${name}: no env vars.`;
  // Never echo secret values back to the agent — only the keys.
  return `${name} env:\n${envs.map((e) => `  ${e.key}=${e.is_secret ? '<secret>' : e.value ?? ''}`).join('\n')}`;
}

export async function setEnv(nameOrUuid: string, key: string, value: string): Promise<string> {
  const { uuid, name } = await resolveUuid(nameOrUuid);
  const payload = JSON.stringify({ key, value, is_preview: false });
  // PATCH updates an existing key; if it doesn't exist Coolify 404s → POST creates.
  try {
    await api(`/applications/${uuid}/envs`, { method: 'PATCH', body: payload });
  } catch {
    await api(`/applications/${uuid}/envs`, { method: 'POST', body: payload });
  }
  return `Set ${key} on ${name} [${uuid}] (redeploy for it to take effect).`;
}
