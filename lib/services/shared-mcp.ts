/**
 * Org-shared MCP servers.
 *
 * An admin registers a server once (Global Settings → Shared MCP) and it is
 * auto-attached to EVERY project's agent run in the org — no per-project setup.
 * This is the "company MCP" tier: an internal docs server, a shared Relume/SEO
 * account, a company database MCP, etc. Contrast with per-project servers
 * (lib/services/project-mcp) which one user adds to one project.
 *
 * Shared servers use a SHARED credential — a static auth header (http/sse) or
 * stdio env — not per-user OAuth, because the whole team uses the one account.
 * Secrets are encrypted at rest and never returned to the client.
 *
 * Scope: orgId null = instance-wide (every project, incl. the auth-off
 * single-tenant case); orgId set = only projects in that org.
 */
import { prisma } from '@/lib/db/client';
import { encrypt, decrypt } from '@/lib/crypto';
import { assertHostAllowed } from '@/lib/services/itops/net';
import type { McpEntry, McpTransport } from '@/lib/services/project-mcp';
import type { SharedMcpServer } from '@prisma/client';

// Same reserved names as project MCP — a shared server must not shadow a brokered tool.
const RESERVED_NAMES = new Set(['appdiag', 'images', 'itops']);
const NAME_RE = /^[a-z0-9_-]{1,40}$/;

export interface SharedMcpInput {
  name: string;
  label?: string;
  transport: McpTransport;
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  headers?: Record<string, string> | null;
  env?: Record<string, string> | null;
  enabled?: boolean;
}

/** UI-safe view — never includes decrypted secrets, only whether they are set. */
export interface SharedMcpView {
  id: string;
  orgId: string | null;
  name: string;
  label: string;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  args: string[];
  hasHeaders: boolean;
  hasEnv: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function toView(row: SharedMcpServer): SharedMcpView {
  return {
    id: row.id, orgId: row.orgId, name: row.name, label: row.label,
    transport: row.transport as McpTransport,
    url: row.url, command: row.command, args: parseJson<string[]>(row.argsJson, []),
    hasHeaders: Boolean(row.headersEncrypted), hasEnv: Boolean(row.envEncrypted),
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Validate + normalize a shared MCP input. Throws a user-facing Error on bad
 * input. `existingNames` are the other shared server names in the same scope.
 */
export async function validateSharedMcpInput(
  input: SharedMcpInput,
  existingNames: Set<string>,
): Promise<void> {
  const name = (input.name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new Error('Name must be 1–40 chars of a–z, 0–9, "-" or "_".');
  if (RESERVED_NAMES.has(name)) throw new Error(`"${name}" is reserved for a built-in tool.`);
  if (existingNames.has(name)) throw new Error(`A shared server named "${name}" already exists.`);
  if (input.transport === 'http' || input.transport === 'sse') {
    const url = (input.url || '').trim();
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('A valid URL is required.'); }
    if (parsed.protocol !== 'https:') throw new Error('MCP server URL must use https://.');
    await assertHostAllowed(parsed.hostname); // SSRF guard: no localhost/private/metadata
  } else if (input.transport === 'stdio') {
    if (!(input.command || '').trim()) throw new Error('A command is required for a stdio MCP server.');
  } else {
    throw new Error('Transport must be http, sse or stdio.');
  }
}

/** All shared servers in an org (admin view). `orgId=null` lists the instance-wide set. */
export async function listSharedMcpServers(orgId: string | null): Promise<SharedMcpView[]> {
  const rows = await prisma.sharedMcpServer.findMany({
    where: { orgId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toView);
}

export async function createSharedMcpServer(orgId: string | null, input: SharedMcpInput): Promise<SharedMcpView> {
  // Validate URL/SSRF outside the txn (it does DNS) so the txn stays short.
  await validateSharedMcpInput(input, new Set());
  const name = input.name.trim().toLowerCase();
  // The DB @@unique([orgId,name]) does NOT dedup instance-wide rows: SQLite treats
  // NULL orgId as distinct. So enforce the name check + insert atomically in a txn
  // (SQLite serializes writes) to close the read-then-write race.
  const row = await prisma.$transaction(async (tx) => {
    const clash = await tx.sharedMcpServer.findFirst({ where: { orgId, name }, select: { id: true } });
    if (clash) throw new Error(`A shared server named "${name}" already exists.`);
    return tx.sharedMcpServer.create({
      data: {
        orgId,
        name,
        label: (input.label || name).trim(),
        transport: input.transport,
        url: input.transport === 'stdio' ? null : (input.url || '').trim(),
        command: input.transport === 'stdio' ? (input.command || '').trim() : null,
        argsJson: input.transport === 'stdio' && input.args?.length ? JSON.stringify(input.args) : null,
        headersEncrypted: input.headers && Object.keys(input.headers).length ? encrypt(JSON.stringify(input.headers)) : null,
        envEncrypted: input.env && Object.keys(input.env).length ? encrypt(JSON.stringify(input.env)) : null,
        enabled: input.enabled ?? true,
      },
    });
  });
  return toView(row);
}

export async function updateSharedMcpServer(
  id: string, orgId: string | null, patch: Partial<SharedMcpInput>,
): Promise<SharedMcpView | null> {
  const row = await prisma.sharedMcpServer.findFirst({ where: { id, orgId } });
  if (!row) return null;
  const data: Record<string, unknown> = {};
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  if (patch.label !== undefined) data.label = (patch.label || row.label).trim();
  if (patch.url !== undefined) data.url = patch.url ? patch.url.trim() : null;
  if (patch.command !== undefined) data.command = patch.command ? patch.command.trim() : null;
  if (patch.args !== undefined) data.argsJson = patch.args?.length ? JSON.stringify(patch.args) : null;
  if (patch.headers !== undefined) data.headersEncrypted = patch.headers && Object.keys(patch.headers).length ? encrypt(JSON.stringify(patch.headers)) : null;
  if (patch.env !== undefined) data.envEncrypted = patch.env && Object.keys(patch.env).length ? encrypt(JSON.stringify(patch.env)) : null;
  if (patch.url !== undefined && (patch.transport ?? row.transport) !== 'stdio' && (patch.url ?? row.url)) {
    // Re-run the URL guard if the endpoint changed.
    const parsed = new URL((patch.url ?? row.url) as string);
    if (parsed.protocol !== 'https:') throw new Error('MCP server URL must use https://.');
    await assertHostAllowed(parsed.hostname);
  }
  const updated = await prisma.sharedMcpServer.update({ where: { id: row.id }, data });
  return toView(updated);
}

export async function deleteSharedMcpServer(id: string, orgId: string | null): Promise<boolean> {
  const res = await prisma.sharedMcpServer.deleteMany({ where: { id, orgId } });
  return res.count > 0;
}

/** Resolve the org a project belongs to (null when it has none / auth is off). */
async function projectOrgId(projectId: string): Promise<string | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { orgId: true } });
  return p?.orgId ?? null;
}

/**
 * Build the enabled shared MCP servers that apply to a project as a
 * `{ name: McpEntry }` map, ready to merge into the agent's mcpServers. Includes
 * instance-wide servers (orgId null) plus the project's own org. Decrypts
 * secrets — server-side only.
 */
export async function buildSharedMcpConfig(projectId: string): Promise<Record<string, McpEntry>> {
  const orgId = await projectOrgId(projectId);
  // Instance-wide (null) always applies; the project's org applies when it has one.
  const orgFilter = orgId ? [{ orgId: null }, { orgId }] : [{ orgId: null }];
  // A `(null,'x')` and `(org,'x')` can legitimately coexist. Order so instance-wide
  // (null orgId) is applied FIRST and the org-specific row overwrites it in the
  // map below — org-specific wins, deterministically (SQLite sorts NULL first asc).
  const rows = await prisma.sharedMcpServer.findMany({
    where: { enabled: true, OR: orgFilter },
    orderBy: { orgId: 'asc' },
  });
  const out: Record<string, McpEntry> = {};
  for (const row of rows) {
    if (RESERVED_NAMES.has(row.name)) continue; // defensive
    if (row.transport === 'http' || row.transport === 'sse') {
      if (!row.url) continue;
      const headers: Record<string, string> = row.headersEncrypted
        ? parseJson<Record<string, string>>(decrypt(row.headersEncrypted), {}) : {};
      out[row.name] = { type: row.transport, url: row.url, ...(Object.keys(headers).length ? { headers } : {}) };
    } else if (row.transport === 'stdio') {
      if (!row.command) continue;
      const env = row.envEncrypted ? parseJson<Record<string, string>>(decrypt(row.envEncrypted), {}) : undefined;
      out[row.name] = { command: row.command, args: parseJson<string[]>(row.argsJson, []), ...(env && Object.keys(env).length ? { env } : {}) };
    }
  }
  return out;
}

/** Read-only view of shared servers applying to a project, for per-project MCP UI. */
export async function listSharedMcpForProject(projectId: string): Promise<SharedMcpView[]> {
  const orgId = await projectOrgId(projectId);
  const orgFilter = orgId ? [{ orgId: null }, { orgId }] : [{ orgId: null }];
  const rows = await prisma.sharedMcpServer.findMany({ where: { OR: orgFilter }, orderBy: { createdAt: 'asc' } });
  return rows.map(toView);
}
