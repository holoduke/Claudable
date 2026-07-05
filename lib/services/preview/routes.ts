// Per-project preview routing: stable preview-<slug> subdomains + Traefik dynamic route files.
import path from 'path';
import fs from 'fs/promises';

// --- Per-project preview routing --------------------------------------------
// A stable per-project subdomain (preview-<slug>.<domain>) whose Traefik route we
// rewrite to the current port on every start. Because the hostname is keyed to the
// PROJECT (not the port), a port getting reused by another project can never make
// one project's preview show another's — the definitive fix for the port-reuse leak.
const PREVIEW_ROUTE_PREFIX = 'preview-';
// Marker on the first line of every route file we manage, so the boot sweep never
// deletes a non-Claudable file that happens to be named preview-*.yml.
const PREVIEW_ROUTE_MARKER = '# claudable-managed-preview';

export function previewRouteDir(): string | null {
  const d = process.env.TRAEFIK_DYNAMIC_DIR?.trim();
  return d && d.length ? d : null;
}

/** Active when the URL template is {project}-based AND we have a dynamic route dir. */
export function perProjectPreview(): boolean {
  return (process.env.PREVIEW_URL_TEMPLATE || '').includes('{project}') && !!previewRouteDir();
}

function hashSlug(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** projectId → a valid DNS label ('preview-' + slug must stay <= 63 chars).
 * If sanitizing changed the id (two ids could collide) or it's too long, append a
 * hash of the raw id so distinct projects never share a route file. */
export function previewSlug(projectId: string): string {
  const s = projectId.toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '');
  const needsHash = s !== projectId.toLowerCase() || s.length > 55;
  return needsHash ? `${s.slice(0, 46).replace(/-$/u, '')}-${hashSlug(projectId)}` : s;
}

/**
 * The stable PUBLIC preview URL for a project (preview-<slug>.<domain>), or null
 * when this deployment doesn't use per-project subdomains. Keyed to the project
 * (not the port) so it's valid whether or not a preview is currently running —
 * used by the Network overview for the access link.
 */
export function projectPreviewUrl(projectId: string): string | null {
  const tmpl = process.env.PREVIEW_URL_TEMPLATE || '';
  if (tmpl.includes('{project}') && previewRouteDir()) return tmpl.replace('{project}', previewSlug(projectId));
  return null;
}

export function previewUrlFor(projectId: string, port: number): string {
  const tmpl = process.env.PREVIEW_URL_TEMPLATE || '';
  if (tmpl.includes('{project}') && previewRouteDir()) return tmpl.replace('{project}', previewSlug(projectId));
  if (tmpl.includes('{port}')) return tmpl.replace('{port}', String(port));
  return `http://localhost:${port}`;
}

function previewRouteFile(projectId: string): string {
  return path.join(previewRouteDir()!, `${PREVIEW_ROUTE_PREFIX}${previewSlug(projectId)}.yml`);
}

/** Write/refresh this project's Traefik route to point at its current port. */
export async function writePreviewRoute(projectId: string, port: number): Promise<void> {
  const dir = previewRouteDir();
  if (!dir) return;
  let host: string;
  try { host = new URL(previewUrlFor(projectId, port)).host; } catch { return; }
  const gw = process.env.DEPLOY_HOST_GATEWAY || 'host.docker.internal';
  const name = `${PREVIEW_ROUTE_PREFIX}${previewSlug(projectId)}`;
  const yaml = `${PREVIEW_ROUTE_MARKER}
# Per-project route so a reused port can't cross projects.
http:
  routers:
    ${name}:
      rule: "Host(\`${host}\`)"
      entryPoints: [https]
      service: ${name}
      tls:
        certResolver: letsencrypt
  services:
    ${name}:
      loadBalancer:
        servers:
          - url: "http://${gw}:${port}"
`;
  await fs.writeFile(previewRouteFile(projectId), yaml, 'utf8').catch(() => {});
}

export async function removePreviewRoute(projectId: string): Promise<void> {
  if (!previewRouteDir()) return;
  await fs.unlink(previewRouteFile(projectId)).catch(() => {});
}

// --- Composed backend (model B): its own `preview-<slug>-api` subdomain ---
function backendSlug(projectId: string): string {
  return `${previewSlug(projectId)}-api`;
}
export function backendPreviewUrl(projectId: string, port: number): string {
  const tmpl = process.env.PREVIEW_URL_TEMPLATE || '';
  if (tmpl.includes('{project}') && previewRouteDir()) return tmpl.replace('{project}', backendSlug(projectId));
  if (tmpl.includes('{port}')) return tmpl.replace('{port}', String(port));
  return `http://localhost:${port}`;
}
function backendRouteFile(projectId: string): string {
  return path.join(previewRouteDir()!, `${PREVIEW_ROUTE_PREFIX}${backendSlug(projectId)}.yml`);
}
export async function writeBackendRoute(projectId: string, port: number): Promise<void> {
  const dir = previewRouteDir();
  if (!dir) return;
  let host: string;
  try { host = new URL(backendPreviewUrl(projectId, port)).host; } catch { return; }
  const gw = process.env.DEPLOY_HOST_GATEWAY || 'host.docker.internal';
  const name = `${PREVIEW_ROUTE_PREFIX}${backendSlug(projectId)}`;
  const yaml = `${PREVIEW_ROUTE_MARKER}
# Composed-backend route (model B): the project's backend service.
http:
  routers:
    ${name}:
      rule: "Host(\`${host}\`)"
      entryPoints: [https]
      service: ${name}
      tls:
        certResolver: letsencrypt
  services:
    ${name}:
      loadBalancer:
        servers:
          - url: "http://${gw}:${port}"
`;
  await fs.writeFile(backendRouteFile(projectId), yaml, 'utf8').catch(() => {});
}
export async function removeBackendRoute(projectId: string): Promise<void> {
  if (!previewRouteDir()) return;
  await fs.unlink(backendRouteFile(projectId)).catch(() => {});
}

/** On boot, remove stale per-project preview routes (their dev servers are dead).
 * Only deletes files that carry OUR marker — never a legit app route that happens
 * to be named preview-*.yml in the shared proxy dir. */
export async function sweepPreviewRoutes(): Promise<void> {
  const dir = previewRouteDir();
  if (!dir) return;
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    files
      .filter((f) => f.startsWith(PREVIEW_ROUTE_PREFIX) && f.endsWith('.yml'))
      .map(async (f) => {
        const p = path.join(dir, f);
        const content = await fs.readFile(p, 'utf8').catch(() => '');
        if (content.startsWith(PREVIEW_ROUTE_MARKER)) await fs.unlink(p).catch(() => {});
      }),
  );
}
