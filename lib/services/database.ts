/**
 * One-click per-project Postgres, provisioned through Coolify.
 *
 * Creates a Postgres database via the Coolify API, exposes it on a host port
 * (is_public) so the preview dev-server and deployed app — both on host
 * networking — can reach it at 127.0.0.1:<port>, and stores the (encrypted)
 * DATABASE_URL on the project so it can be injected into preview + deploy.
 */
import { randomBytes } from 'crypto';
import { encrypt, decrypt } from '@/lib/crypto';
import { getProjectService, upsertProjectServiceConnection } from '@/lib/services/project-services';
import { prisma } from '@/lib/db/client';

const DB_PORT_BASE = 5500;
const DB_PORT_SPAN = 100; // 5500..5599
const HOST = process.env.PREVIEW_DB_HOST || '127.0.0.1';

function coolifyConfigured(): boolean {
  return !!process.env.COOLIFY_API_TOKEN?.trim();
}
function base(): string {
  return (process.env.COOLIFY_API_BASE || 'http://localhost:8000').replace(/\/+$/u, '');
}
async function api(path: string, init?: RequestInit): Promise<any> {
  const token = process.env.COOLIFY_API_TOKEN?.trim();
  if (!token) throw new Error('Coolify not configured (set COOLIFY_API_TOKEN).');
  const res = await fetch(`${base()}/api/v1${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Coolify ${res.status}: ${body.slice(0, 300)}`);
  return body.length ? JSON.parse(body) : null;
}

function slug(s: string): string {
  return (s.toLowerCase().replace(/[^a-z0-9]/gu, '_').replace(/_+/gu, '_').replace(/^_|_$/gu, '') || 'app').slice(0, 24);
}
function portFor(projectId: string): number {
  let h = 0;
  for (let i = 0; i < projectId.length; i += 1) h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  return DB_PORT_BASE + (h % DB_PORT_SPAN);
}

/** Find or create the Coolify project that holds Claudable-provisioned databases. */
async function ensureDatabasesProject(): Promise<{ projectUuid: string; environmentName: string }> {
  const projects = (await api('/projects')) as Array<{ uuid: string; name: string }>;
  let proj = projects.find((p) => p.name === 'claudable-databases');
  if (!proj) {
    const created = (await api('/projects', { method: 'POST', body: JSON.stringify({ name: 'claudable-databases', description: 'Per-project databases provisioned by Claudable' }) })) as { uuid: string };
    proj = { uuid: created.uuid, name: 'claudable-databases' };
  }
  return { projectUuid: proj.uuid, environmentName: 'production' };
}

export interface DatabaseInfo {
  provisioned: boolean;
  status?: string;
  engine?: 'postgresql';
  host?: string;
  port?: number;
  database?: string;
  coolifyUuid?: string;
}

/** Public (no-secret) view of a project's database for the UI. */
export async function getDatabaseInfo(projectId: string): Promise<DatabaseInfo> {
  const svc = await getProjectService(projectId, 'database');
  const data = svc?.serviceData as Record<string, any> | undefined;
  if (!data?.coolifyUuid) return { provisioned: false };
  return {
    provisioned: true,
    status: data.status,
    engine: 'postgresql',
    host: HOST,
    port: data.port,
    database: data.database,
    coolifyUuid: data.coolifyUuid,
  };
}

/** The full DATABASE_URL (decrypted) — for injecting into preview/deploy only. */
export async function getDatabaseUrl(projectId: string): Promise<string | null> {
  const svc = await getProjectService(projectId, 'database');
  const enc = (svc?.serviceData as Record<string, any> | undefined)?.databaseUrlEnc;
  if (!enc) return null;
  try { return decrypt(enc); } catch { return null; }
}

/** Provision a Postgres for a project (idempotent — returns the existing one). */
export async function provisionPostgres(projectId: string): Promise<DatabaseInfo> {
  if (!coolifyConfigured()) throw new Error('Coolify is not configured on this server.');
  const existing = await getDatabaseInfo(projectId);
  if (existing.provisioned) return existing;

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
  const dbName = slug(project?.name || projectId);
  const user = 'app';
  const password = randomBytes(18).toString('base64url');
  const port = portFor(projectId);
  const serverUuid = process.env.COOLIFY_SERVER_UUID?.trim();
  if (!serverUuid) throw new Error('COOLIFY_SERVER_UUID not set.');
  const { projectUuid, environmentName } = await ensureDatabasesProject();

  const created = (await api('/databases/postgresql', {
    method: 'POST',
    body: JSON.stringify({
      server_uuid: serverUuid,
      project_uuid: projectUuid,
      environment_name: environmentName,
      name: `db-${slug(project?.name || projectId)}-${port}`,
      postgres_user: user,
      postgres_password: password,
      postgres_db: dbName,
      is_public: true,
      public_port: port,
      instant_deploy: true,
    }),
  })) as { uuid: string };

  const databaseUrl = `postgresql://${user}:${password}@${HOST}:${port}/${dbName}`;
  await upsertProjectServiceConnection(projectId, 'database', {
    engine: 'postgresql',
    coolifyUuid: created.uuid,
    port,
    database: dbName,
    user,
    status: 'deploying',
    databaseUrlEnc: encrypt(databaseUrl),
  });

  return { provisioned: true, status: 'deploying', engine: 'postgresql', host: HOST, port, database: dbName, coolifyUuid: created.uuid };
}

/** Delete the Coolify database + forget the connection. */
export async function removeDatabase(projectId: string): Promise<boolean> {
  const svc = await getProjectService(projectId, 'database');
  const uuid = (svc?.serviceData as Record<string, any> | undefined)?.coolifyUuid;
  if (uuid && coolifyConfigured()) {
    await api(`/databases/${encodeURIComponent(uuid)}`, { method: 'DELETE' }).catch(() => {});
  }
  await prisma.projectServiceConnection.deleteMany({ where: { projectId, provider: 'database' } });
  return true;
}
