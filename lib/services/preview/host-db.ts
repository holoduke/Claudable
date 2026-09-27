// A project's one-click Coolify database, reachable from its ISOLATED preview.
//
// The Coolify DB is published on a host port (e.g. 127.0.0.1:5564). The preview
// container sits on the egress-locked sandbox network, which (by design) cannot
// reach the host — so such projects used to run their dev server IN the Claudable
// process instead: project code in the control plane, next to every other
// project's files and Claudable's own credentials.
//
// Instead, the DB container joins the project's own internal network under an
// alias; only that project's preview (and backend) is on that network. The
// DATABASE_URL handed to the preview is rewritten to alias:<internal port>.
import { getProjectService } from '@/lib/services/project-services';
import { getDatabaseUrl } from '@/lib/services/database';
import { connectToProjectNet, dockerCapture, ensureProjectNetwork } from './docker';

export const HOST_DB_ALIAS = 'projectdb';
const INTERNAL_PORT: Record<string, number> = { postgresql: 5432, postgres: 5432, mysql: 3306, mariadb: 3306 };
// Coolify resource uuids: lowercase alnum. Validated before it reaches docker argv.
const UUID_RE = /^[a-z0-9]{8,64}$/u;

/** The DB URL as seen from inside the project network, or null if unsupported. */
export function rewriteHostDbUrl(url: string, engine: string): string | null {
  const port = INTERNAL_PORT[engine.toLowerCase()];
  if (!port) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^(postgres|postgresql|mysql|mariadb):$/u.test(u.protocol)) return null;
  u.hostname = HOST_DB_ALIAS;
  u.port = String(port);
  return u.toString();
}

/**
 * Attach the project's Coolify DB to its project network and return the URL to
 * use there. Null when the project has no Coolify DB. Throws when it has one but
 * it can't be attached — the caller must then NOT fall back to running the
 * project in-process.
 */
export async function attachHostDb(projectId: string): Promise<string | null> {
  const svc = await getProjectService(projectId, 'database');
  const data = svc?.serviceData as Record<string, unknown> | undefined;
  const url = await getDatabaseUrl(projectId);
  if (!data || !url) return null;
  const uuid = typeof data.coolifyUuid === 'string' ? data.coolifyUuid : '';
  const engine = typeof data.engine === 'string' ? data.engine : 'postgresql';
  const internalUrl = rewriteHostDbUrl(url, engine);
  if (!UUID_RE.test(uuid) || !internalUrl) {
    throw new Error('The project database cannot be attached to the isolated preview (unknown database container or engine).');
  }
  const running = await dockerCapture(['inspect', '-f', '{{.State.Running}}', uuid]);
  if (running?.trim() !== 'true') {
    throw new Error('The project database container is not running — start it in Settings → Database, then start the preview again.');
  }
  const net = await ensureProjectNetwork(projectId);
  await connectToProjectNet(net, uuid, HOST_DB_ALIAS);
  const attached = await dockerCapture(['inspect', '-f', `{{with index .NetworkSettings.Networks "${net}"}}ok{{end}}`, uuid]);
  if (attached?.trim() !== 'ok') {
    throw new Error('Could not connect the project database to the isolated preview network.');
  }
  return internalUrl;
}
