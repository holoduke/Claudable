/**
 * Traefik dynamic-route operations for the it-ops broker.
 *
 * Traefik (the Coolify proxy) hot-watches a dynamic-config directory; dropping a
 * `<app>.yml` router/service file there publishes a route (and auto-HTTPS via the
 * existing Route53 DNS-01 resolver). This is exactly how the Gitea-Actions deploy
 * already wires apps — these tools just let the broker do it directly.
 *
 * Runs IN the Claudable process. Opt-in per deployment: the host's Traefik
 * dynamic dir must be mounted into the container AND TRAEFIK_DYNAMIC_DIR set to
 * that in-container path. If either is absent every op returns a "not configured"
 * notice rather than throwing (so this is inert on deployments that don't use it).
 *
 * Safety: filenames are restricted to `[a-z0-9._-]+.yml` (no path traversal), and
 * writes must look like a Traefik dynamic config (contain `http:` with routers or
 * services) so a malformed blob can't silently brick routing.
 */
import { promises as fs } from 'fs';
import path from 'path';

/** Null unless TRAEFIK_DYNAMIC_DIR is explicitly set (opt-in per deployment). */
function dirOrNull(): string | null {
  const d = process.env.TRAEFIK_DYNAMIC_DIR?.trim();
  return d && d.length ? d : null;
}

function dir(): string {
  const d = dirOrNull();
  if (!d) throw new Error('Traefik dynamic dir not configured (set TRAEFIK_DYNAMIC_DIR + mount it).');
  return d;
}

export async function traefikConfigured(): Promise<boolean> {
  const d = dirOrNull();
  if (!d) return false;
  try {
    return (await fs.stat(d)).isDirectory();
  } catch {
    return false;
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*\.yml$/u;

function safeName(name: string): string {
  const base = name.endsWith('.yml') ? name : `${name}.yml`;
  if (!NAME_RE.test(base) || base.includes('..') || base.includes('/')) {
    throw new Error(`Invalid route filename "${name}" (allowed: lowercase a-z0-9._- ending in .yml).`);
  }
  return base;
}

export async function listRoutes(): Promise<string> {
  const files = (await fs.readdir(dir())).filter((f) => f.endsWith('.yml'));
  if (!files.length) return 'No dynamic route files.';
  return files.map((f) => `- ${f}`).join('\n');
}

export async function readRoute(name: string): Promise<string> {
  const file = path.join(dir(), safeName(name));
  return fs.readFile(file, 'utf8');
}

export async function writeRoute(name: string, yaml: string): Promise<string> {
  if (!/http\s*:/u.test(yaml) || !/(routers|services)\s*:/u.test(yaml)) {
    throw new Error('Refusing to write: content does not look like a Traefik dynamic config (needs http: with routers/services).');
  }
  const file = path.join(dir(), safeName(name));
  await fs.writeFile(file, yaml, 'utf8');
  return `Wrote ${safeName(name)} — Traefik will hot-reload it within seconds.`;
}

export async function removeRoute(name: string): Promise<string> {
  const file = path.join(dir(), safeName(name));
  await fs.unlink(file);
  return `Removed ${safeName(name)} — its route is withdrawn.`;
}
