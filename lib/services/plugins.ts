/**
 * Claude Code PLUGINS for Claudable.
 *
 * An admin registers a plugin MARKETPLACE (a git repo with
 * .claude-plugin/marketplace.json) once in Global Settings, and its plugins are
 * available to EVERY project's agent — the "company plugins" tier, alongside
 * shared MCP servers and the global skills catalog.
 *
 * How it works (deliberately mirrors skills + shared-mcp, and the CLI's own
 * plugin model):
 *  - Claudable clones the marketplace repo in the CONTROL PLANE using the git
 *    ServiceToken, exactly like git push — the token is embedded in the remote
 *    URL and NEVER reaches the sandboxed agent container.
 *  - The clone is sanitized (bundled MCP servers stripped by default; see
 *    sanitizePluginDir) and lives under a shared host dir that is mounted
 *    read-only into every agent turn.
 *  - Each enabled plugin is loaded via the CLI's own `--plugin-dir <path>` flag
 *    (per-session, repeatable) — no marketplace metadata/cache to keep in sync,
 *    fully path-relocatable across the per-project agent containers.
 *
 * Scope: orgId null = instance-wide (every project, incl. the auth-off
 * single-tenant case); orgId set = only that org's projects. Per-project
 * opt-out lives in a project state file (see plugins-state), mirroring skills.
 */
import path from 'path';
import fs from 'fs/promises';
import { spawnSync } from 'child_process';
import { prisma } from '@/lib/db/client';
import { redactGitSecrets } from '@/lib/services/git';
import { getEnvGitToken } from '@/lib/services/git-provider';
import { getPlainServiceToken } from '@/lib/services/tokens';
import type { PluginMarketplace } from '@prisma/client';

// Where the app process writes marketplace clones (visible in the app container
// at /app/data/agent-plugins via ./data:/app/data).
const PLUGINS_DIR = process.env.PLUGINS_DIR || './data/agent-plugins';
export const PLUGINS_DIR_ABSOLUTE = path.isAbsolute(PLUGINS_DIR)
  ? PLUGINS_DIR
  : path.resolve(process.cwd(), PLUGINS_DIR);

// Path the shared plugins dir is mounted at, read-only, inside each agent
// container. Plugin dirs passed to `--plugin-dir` are built from this.
export const CONTAINER_PLUGINS_MOUNT = '/plugins';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/i;

/**
 * Host path of the shared plugins dir, for the agent container's read-only
 * mount. Clones live INSIDE the data dir (PLUGINS_DIR = ./data/agent-plugins,
 * already writable in the app via ./data:/app/data), so the host mount path is
 * DATA_HOST_DIR/agent-plugins — the host location that backs /app/data. Explicit
 * env wins. Undefined when neither is set (local non-containerized dev), in
 * which case the agent mount is simply skipped.
 */
export function pluginsHostDir(): string | undefined {
  const explicit = process.env.AGENT_PLUGINS_HOST_DIR?.trim();
  if (explicit) return explicit;
  const dataHost = process.env.DATA_HOST_DIR?.trim();
  if (dataHost) return path.join(dataHost, 'agent-plugins');
  return undefined;
}

export interface CatalogPlugin {
  name: string;
  source: string; // repo-relative path to the plugin root, e.g. "./plugins/newstory/newstory-global"
  description?: string;
  version?: string;
}

export interface MarketplaceView {
  id: string;
  name: string;
  gitUrl: string;
  ref: string | null;
  subpath: string | null;
  enabled: boolean;
  includeMcpServers: boolean;
  catalog: CatalogPlugin[];
  enabledPlugins: string[]; // plugin names enabled org-wide
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  syncedRef: string | null;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function parseCatalog(json: string | null): CatalogPlugin[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Plugin names enabled org-wide. Null column = "all catalog plugins enabled". */
function enabledNames(m: PluginMarketplace): string[] {
  const catalog = parseCatalog(m.catalogJson);
  if (!m.enabledPluginsJson) return catalog.map((p) => p.name);
  try {
    const list = JSON.parse(m.enabledPluginsJson);
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return catalog.map((p) => p.name);
  }
}

export function toView(m: PluginMarketplace): MarketplaceView {
  return {
    id: m.id,
    name: m.name,
    gitUrl: m.gitUrl,
    ref: m.ref,
    subpath: m.subpath,
    enabled: m.enabled,
    includeMcpServers: m.includeMcpServers,
    catalog: parseCatalog(m.catalogJson),
    enabledPlugins: enabledNames(m),
    lastSyncedAt: m.lastSyncedAt?.toISOString() ?? null,
    lastSyncError: m.lastSyncError,
    syncedRef: m.syncedRef,
  };
}

// --- CRUD -----------------------------------------------------------------

export async function listMarketplaces(orgId: string | null): Promise<MarketplaceView[]> {
  const rows = await prisma.pluginMarketplace.findMany({
    where: orgId === null ? {} : { OR: [{ orgId: null }, { orgId }] },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toView);
}

export interface AddMarketplaceInput {
  name: string;
  gitUrl: string;
  ref?: string | null;
  subpath?: string | null;
  tokenProvider?: string;
  includeMcpServers?: boolean;
}

export async function addMarketplace(orgId: string | null, input: AddMarketplaceInput): Promise<MarketplaceView> {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) throw new Error('Marketplace name must be alphanumeric with - or _ (max 60 chars)');
  if (!/^https:\/\/[^\s]+$/.test(input.gitUrl.trim())) throw new Error('gitUrl must be an https git URL');
  // SQLite treats NULLs as distinct in a unique index, so a manual existence
  // check is needed for the instance-wide (orgId null) case — mirrors shared-mcp.
  const existing = await prisma.pluginMarketplace.findFirst({ where: { orgId, name } });
  if (existing) throw new Error(`A marketplace named "${name}" already exists`);
  const created = await prisma.pluginMarketplace.create({
    data: {
      orgId,
      name,
      gitUrl: input.gitUrl.trim(),
      ref: input.ref?.trim() || null,
      subpath: input.subpath?.trim().replace(/^\/+|\/+$/g, '') || null,
      tokenProvider: input.tokenProvider?.trim() || 'github',
      includeMcpServers: input.includeMcpServers ?? false,
    },
  });
  return toView(created);
}

async function loadScoped(orgId: string | null, id: string): Promise<PluginMarketplace> {
  const m = await prisma.pluginMarketplace.findUnique({ where: { id } });
  if (!m) throw new Error('Marketplace not found');
  // An org admin may only touch instance-wide rows or their own org's rows.
  if (orgId !== null && m.orgId !== null && m.orgId !== orgId) throw new Error('Marketplace not found');
  return m;
}

export async function updateMarketplace(
  orgId: string | null,
  id: string,
  patch: { enabled?: boolean; includeMcpServers?: boolean; ref?: string | null },
): Promise<MarketplaceView> {
  await loadScoped(orgId, id);
  const updated = await prisma.pluginMarketplace.update({
    where: { id },
    data: {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.includeMcpServers !== undefined ? { includeMcpServers: patch.includeMcpServers } : {}),
      ...(patch.ref !== undefined ? { ref: patch.ref?.trim() || null } : {}),
    },
  });
  return toView(updated);
}

export async function setPluginEnabled(
  orgId: string | null,
  id: string,
  pluginName: string,
  enabled: boolean,
): Promise<MarketplaceView> {
  const m = await loadScoped(orgId, id);
  const catalog = parseCatalog(m.catalogJson);
  if (!catalog.some((p) => p.name === pluginName)) throw new Error(`Plugin "${pluginName}" is not in this marketplace`);
  const current = new Set(enabledNames(m));
  if (enabled) current.add(pluginName);
  else current.delete(pluginName);
  const updated = await prisma.pluginMarketplace.update({
    where: { id },
    data: { enabledPluginsJson: JSON.stringify([...current]) },
  });
  return toView(updated);
}

export async function removeMarketplace(orgId: string | null, id: string): Promise<void> {
  const m = await loadScoped(orgId, id);
  await prisma.pluginMarketplace.delete({ where: { id } });
  // Best-effort clean of the on-disk clone.
  await fs.rm(path.join(PLUGINS_DIR_ABSOLUTE, slugify(m.name)), { recursive: true, force: true }).catch(() => {});
}

// --- Sync (clone + parse + sanitize) -------------------------------------

async function resolveToken(provider: string): Promise<string | null> {
  const env = getEnvGitToken();
  if (env) return env;
  return (await getPlainServiceToken(provider)) ?? null;
}

/** Build an https clone URL with the token embedded (GitHub accepts
 *  x-access-token:<token>). The returned string contains a secret — never log
 *  it un-redacted. */
function authenticatedUrl(gitUrl: string, token: string | null): string {
  if (!token) return gitUrl;
  return gitUrl.replace(/^https:\/\//, `https://x-access-token:${encodeURIComponent(token)}@`);
}

function git(args: string[], cwd: string): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(redactGitSecrets((res.stderr || res.stdout || `git ${args.join(' ')} failed`).trim()));
  }
}

/**
 * Remove a plugin's bundled MCP servers so they can't hang or fail-to-start in
 * the linux agent sandbox (they commonly ship platform-specific binaries with
 * autoInstall). Deletes the plugin-root .mcp.json. Called unless the
 * marketplace opts into includeMcpServers.
 */
async function sanitizePluginDir(pluginRoot: string): Promise<void> {
  await fs.rm(path.join(pluginRoot, '.mcp.json'), { force: true }).catch(() => {});
}

/**
 * Clone/refresh the marketplace repo, parse its catalog, and sanitize it.
 * Stores catalog + sync status on the row. The clone happens in the control
 * plane; the auth token never touches the agent container.
 */
export async function syncMarketplace(orgId: string | null, id: string): Promise<MarketplaceView> {
  const m = await loadScoped(orgId, id);
  const slug = slugify(m.name);
  const dest = path.join(PLUGINS_DIR_ABSOLUTE, slug);
  try {
    const token = await resolveToken(m.tokenProvider);
    const url = authenticatedUrl(m.gitUrl, token);
    await fs.mkdir(PLUGINS_DIR_ABSOLUTE, { recursive: true });
    // Fresh clone each sync (simple + deterministic; repos are small). Clone to a
    // temp dir then swap, so a failed clone never leaves a half-updated tree.
    const tmp = `${dest}.tmp-${process.pid}`;
    await fs.rm(tmp, { recursive: true, force: true });
    const cloneArgs = ['clone', '--depth', '1'];
    if (m.ref) cloneArgs.push('--branch', m.ref);
    cloneArgs.push(url, tmp);
    git(cloneArgs, PLUGINS_DIR_ABSOLUTE);
    const syncedRef = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).stdout?.trim() || null;

    const marketRoot = m.subpath ? path.join(tmp, m.subpath) : tmp;
    const manifestPath = path.join(marketRoot, '.claude-plugin', 'marketplace.json');
    const manifestRaw = await fs.readFile(manifestPath, 'utf8').catch(() => {
      throw new Error('.claude-plugin/marketplace.json not found in the repo');
    });
    const manifest = JSON.parse(manifestRaw);
    const plugins: CatalogPlugin[] = Array.isArray(manifest.plugins)
      ? manifest.plugins.map((p: Record<string, unknown>) => ({
          name: String(p.name),
          source: String(p.source),
          description: p.description ? String(p.description) : undefined,
          version: p.version ? String(p.version) : undefined,
        }))
      : [];
    if (!plugins.length) throw new Error('marketplace.json lists no plugins');

    // Sanitize each plugin's MCP servers unless opted in.
    if (!m.includeMcpServers) {
      for (const p of plugins) {
        await sanitizePluginDir(path.resolve(marketRoot, p.source));
      }
    }

    // Atomic-ish swap into place.
    await fs.rm(dest, { recursive: true, force: true });
    await fs.rename(tmp, dest);

    const updated = await prisma.pluginMarketplace.update({
      where: { id },
      data: {
        catalogJson: JSON.stringify(plugins),
        // Preserve an explicit enabled set; default (null) means "all enabled".
        lastSyncedAt: new Date(),
        lastSyncError: null,
        syncedRef,
      },
    });
    return toView(updated);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Sync failed';
    await prisma.pluginMarketplace.update({ where: { id }, data: { lastSyncError: message, lastSyncedAt: new Date() } }).catch(() => {});
    await fs.rm(`${dest}.tmp-${process.pid}`, { recursive: true, force: true }).catch(() => {});
    throw new Error(message);
  }
}

// --- Per-project enablement + resolution for a turn -----------------------

/**
 * The absolute container path (under CONTAINER_PLUGINS_MOUNT) of a plugin root,
 * derived from the marketplace slug and the catalog plugin's repo-relative
 * source. This is what gets passed to `--plugin-dir`.
 */
export function pluginContainerDir(marketplaceName: string, subpath: string | null, source: string): string {
  const rel = source.replace(/^\.?\/+/, '');
  const base = subpath ? `${slugify(marketplaceName)}/${subpath.replace(/^\/+|\/+$/g, '')}` : slugify(marketplaceName);
  return path.posix.join(CONTAINER_PLUGINS_MOUNT, base, rel);
}

/** Host path of a plugin root — used to verify the clone actually contains it. */
export function pluginHostDir(marketplaceName: string, subpath: string | null, source: string): string {
  const rel = source.replace(/^\.?\/+/, '');
  const base = subpath ? path.join(slugify(marketplaceName), subpath.replace(/^\/+|\/+$/g, '')) : slugify(marketplaceName);
  return path.join(PLUGINS_DIR_ABSOLUTE, base, rel);
}

// --- Per-project override + resolution for an agent turn ------------------

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(process.cwd(), PROJECTS_DIR);

// <project>/.claude/.plugins-state.json — { disabled: ["<marketplace>/<plugin>"] }.
// Mirrors the skills state file: org-enabled is the default, this only records
// per-project opt-OUTs. The key is marketplace-name/plugin-name.
const STATE_FILE = '.plugins-state.json';

function stateFilePath(projectId: string): string {
  return path.join(PROJECTS_DIR_ABSOLUTE, projectId, '.claude', STATE_FILE);
}

function pluginKey(marketplaceName: string, pluginName: string): string {
  return `${marketplaceName}/${pluginName}`;
}

async function getProjectDisabled(projectId: string): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(stateFilePath(projectId), 'utf8');
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed?.disabled) ? parsed.disabled.filter((x: unknown): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

async function projectOrgId(projectId: string): Promise<string | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { orgId: true } });
  return p?.orgId ?? null;
}

/** Toggle a plugin on/off for one project (overrides the org default). */
export async function setProjectPluginEnabled(projectId: string, marketplaceName: string, pluginName: string, enabled: boolean): Promise<void> {
  const file = stateFilePath(projectId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const disabled = await getProjectDisabled(projectId);
  const key = pluginKey(marketplaceName, pluginName);
  if (enabled) disabled.delete(key);
  else disabled.add(key);
  await fs.writeFile(file, JSON.stringify({ disabled: [...disabled] }, null, 2));
}

export interface EffectivePlugin {
  marketplace: string;
  name: string;
  description?: string;
  enabled: boolean; // effective for this project (org-enabled AND not project-disabled)
  synced: boolean;  // the plugin dir is present on disk
}

/**
 * The plugins that apply to a project (instance-wide + its org), with their
 * effective on/off state. Powers the per-project UI and the /command list.
 */
export async function listEffectivePlugins(projectId: string): Promise<EffectivePlugin[]> {
  const orgId = await projectOrgId(projectId);
  const orgFilter = orgId ? [{ orgId: null }, { orgId }] : [{ orgId: null }];
  const rows = await prisma.pluginMarketplace.findMany({ where: { enabled: true, OR: orgFilter }, orderBy: { createdAt: 'asc' } });
  const disabled = await getProjectDisabled(projectId);
  const out: EffectivePlugin[] = [];
  for (const m of rows) {
    const orgEnabled = new Set(enabledNames(m));
    for (const p of parseCatalog(m.catalogJson)) {
      const on = orgEnabled.has(p.name) && !disabled.has(pluginKey(m.name, p.name));
      const synced = await pathExists(pluginHostDir(m.name, m.subpath, p.source));
      out.push({ marketplace: m.name, name: p.name, description: p.description, enabled: on, synced });
    }
  }
  return out;
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * The `--plugin-dir` container paths for every plugin effective in a project.
 * Used at agent-turn build time. Only returns plugins whose clone is present on
 * disk (a mis-synced marketplace silently contributes nothing rather than
 * passing a path that would make the CLI error).
 */
export async function resolveEnabledPluginDirs(projectId: string): Promise<string[]> {
  const effective = await listEffectivePlugins(projectId);
  const orgId = await projectOrgId(projectId);
  const orgFilter = orgId ? [{ orgId: null }, { orgId }] : [{ orgId: null }];
  const rows = await prisma.pluginMarketplace.findMany({ where: { enabled: true, OR: orgFilter } });
  const byName = new Map(rows.map((m) => [m.name, m]));
  const dirs: string[] = [];
  for (const p of effective) {
    if (!p.enabled || !p.synced) continue;
    const m = byName.get(p.marketplace);
    if (!m) continue;
    const source = parseCatalog(m.catalogJson).find((c) => c.name === p.name)?.source;
    if (!source) continue;
    dirs.push(pluginContainerDir(m.name, m.subpath, source));
  }
  return dirs;
}

export { slugify };
