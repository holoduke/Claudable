/**
 * Runtime port for a self-hosted deploy (host network, one port per site).
 *
 * The first guess is a hash of the site name, but a hash alone collides: two
 * sites in the same band can land on the same port, and the second one then
 * silently routes its domain to the first app. So the port is checked against
 * every other site's Traefik route and against anything already listening on
 * the host, and the choice is kept in the repo's docker-compose.yml so later
 * publishes reuse it.
 */

import fs from 'fs/promises';
import net from 'net';
import path from 'path';

const DEPLOY_PORT_BASE = Number(process.env.DEPLOY_PORT_BASE || 3500);
const DEPLOY_PORT_SPAN = Number(process.env.DEPLOY_PORT_SPAN || 400); // band [3500, 3899]
const PREVIEW_PORT_START = Number(process.env.PREVIEW_PORT_START || 3710);
const PREVIEW_PORT_END = Number(process.env.PREVIEW_PORT_END || 3799);

const NODE_PORT_LINE = /^(\s*-\s*(?:NITRO_)?PORT=)(\d+)\s*$/gmu;
const PUBLISHED_PORT_LINE = /^(\s*-\s*"?)(\d+)(:80"?\s*)$/gmu;
const ROUTE_URL_PORT = /url:\s*"?https?:\/\/[^\s":/]+:(\d+)/gu;

export function hashPortFor(site: string): number {
  let hash = 0;
  for (let i = 0; i < site.length; i += 1) {
    hash = (hash * 31 + site.charCodeAt(i)) >>> 0;
  }
  return DEPLOY_PORT_BASE + (hash % DEPLOY_PORT_SPAN);
}

/** The port a docker-compose.yml currently runs the app on, or null. */
export function composePort(compose: string): number | null {
  const node = /^\s*-\s*PORT=(\d+)\s*$/mu.exec(compose);
  if (node) return Number(node[1]);
  const published = /^\s*-\s*"?(\d+):80"?\s*$/mu.exec(compose);
  return published ? Number(published[1]) : null;
}

/** Same compose with the app port moved from `from` to `to` (other lines untouched). */
export function rewriteComposePort(compose: string, from: number, to: number): string {
  const swap = (whole: string, head: string, value: string, tail = '') =>
    Number(value) === from ? `${head}${to}${tail}` : whole;
  return compose
    .replace(NODE_PORT_LINE, (whole, head: string, value: string) => swap(whole, head, value))
    .replace(PUBLISHED_PORT_LINE, (whole, head: string, value: string, tail: string) => swap(whole, head, value, tail));
}

interface RoutePorts {
  /** Ports in the Traefik routes of every OTHER site. */
  others: Set<number>;
  /** Ports in this site's own route (its running container may hold them). */
  own: Set<number>;
}

/** Ports referenced by the Traefik route files (empty when the dir isn't mounted). */
export async function routePorts(site: string, dir = process.env.TRAEFIK_DYNAMIC_DIR?.trim()): Promise<RoutePorts> {
  const result: RoutePorts = { others: new Set(), own: new Set() };
  if (!dir) return result;
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch (error) {
    console.warn('[deploy-port] cannot read Traefik routes:', error instanceof Error ? error.message : error);
    return result;
  }
  const ownFiles = new Set([`${site}.yml`, `${site}.yaml`]);
  for (const file of files) {
    if (!/\.ya?ml$/u.test(file)) continue;
    const target = ownFiles.has(file) ? result.own : result.others;
    try {
      const text = await fs.readFile(path.join(dir, file), 'utf8');
      for (const match of text.matchAll(ROUTE_URL_PORT)) target.add(Number(match[1]));
    } catch { /* unreadable route file: ignore */ }
  }
  return result;
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
export function portListening(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

interface ResolveDeps {
  routes?: RoutePorts;
  isListening?: (port: number) => Promise<boolean>;
}

/**
 * Pick the deploy port. Keeps the compose port when no other site routes to
 * it. Otherwise prefers the port of the site's own route (set by an earlier
 * deploy or by hand), then walks the band from the hash guess to the first
 * port that no route uses, isn't a preview port and has no listener.
 */
export async function resolveDeployPort(site: string, currentPort: number | null, deps: ResolveDeps = {}): Promise<number> {
  const { others, own } = deps.routes ?? await routePorts(site);
  const isListening = deps.isListening ?? portListening;
  if (currentPort && !others.has(currentPort)) return currentPort;

  const ownFree = [...own].find((port) => !others.has(port));
  if (ownFree) return ownFree;

  const offset = hashPortFor(site) - DEPLOY_PORT_BASE;
  for (let i = 0; i < DEPLOY_PORT_SPAN; i += 1) {
    const port = DEPLOY_PORT_BASE + ((offset + i) % DEPLOY_PORT_SPAN);
    if (port === currentPort || others.has(port)) continue;
    if (port >= PREVIEW_PORT_START && port <= PREVIEW_PORT_END) continue;
    if (await isListening(port)) continue;
    return port;
  }
  throw new Error(`No free deploy port in ${DEPLOY_PORT_BASE}-${DEPLOY_PORT_BASE + DEPLOY_PORT_SPAN - 1}`);
}
