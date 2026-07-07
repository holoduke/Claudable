/**
 * Per-project MCP servers.
 *
 * Users add MCP servers to a project from Project Settings → "MCP". Enabled
 * servers are merged into the agent's `mcpServers` on every turn — both the
 * in-process SDK path and the containerized `--mcp-config` path (see
 * lib/services/cli/claude.ts and lib/services/agent-mcp-http.ts).
 *
 * Generic by design: an entry is either a remote server (http/sse URL, optional
 * auth headers) or a stdio command server (command + args + env). Secrets (auth
 * headers, stdio env) are encrypted at rest via lib/crypto and never returned to
 * the client.
 */
import { prisma } from '@/lib/db/client';
import { encrypt, decrypt } from '@/lib/crypto';
import { assertHostAllowed } from '@/lib/services/itops/net';

// Built-in brokered servers a project MCP must not shadow.
const RESERVED_NAMES = new Set(['appdiag', 'images', 'itops']);
const NAME_RE = /^[a-z0-9_-]{1,40}$/;

export type McpTransport = 'http' | 'sse' | 'stdio';

export interface McpServerInput {
  name: string;
  label?: string;
  transport: McpTransport;
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  headers?: Record<string, string> | null; // http/sse auth headers
  env?: Record<string, string> | null;      // stdio env
  enabled?: boolean;
}

/** UI-safe view — never includes decrypted secrets, only whether they are set. */
export interface McpServerView {
  id: string;
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

/** The shape consumed by the Claude Agent SDK / CLI mcp-config for one server. */
export type McpEntry =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { command: string; args: string[]; env?: Record<string, string> };

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function toView(row: {
  id: string; name: string; label: string; transport: string; url: string | null;
  command: string | null; argsJson: string | null; headersEncrypted: string | null;
  envEncrypted: string | null; enabled: boolean; createdAt: Date; updatedAt: Date;
}): McpServerView {
  return {
    id: row.id, name: row.name, label: row.label, transport: row.transport as McpTransport,
    url: row.url, command: row.command, args: parseJson<string[]>(row.argsJson, []),
    hasHeaders: Boolean(row.headersEncrypted), hasEnv: Boolean(row.envEncrypted),
    enabled: row.enabled, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Validate + normalize an MCP input. Throws a user-facing Error on bad input.
 * `existingNames` are the project's other server names (to reject duplicates).
 * SSRF/egress guardrails: https-only remote URLs, blocked private/localhost hosts.
 */
export async function validateMcpInput(
  input: McpServerInput,
  existingNames: Set<string>,
): Promise<void> {
  const name = (input.name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new Error('Name must be 1–40 chars of a–z, 0–9, "-" or "_".');
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`"${name}" is reserved for a built-in tool.`);
  }
  if (existingNames.has(name)) {
    throw new Error(`A server named "${name}" already exists for this project.`);
  }
  if (input.transport === 'http' || input.transport === 'sse') {
    const url = (input.url || '').trim();
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('A valid URL is required.'); }
    if (parsed.protocol !== 'https:') {
      throw new Error('MCP server URL must use https://.');
    }
    // SSRF guard: block localhost / private ranges / cloud metadata.
    await assertHostAllowed(parsed.hostname);
  } else if (input.transport === 'stdio') {
    if (!(input.command || '').trim()) {
      throw new Error('A command is required for a stdio MCP server.');
    }
  } else {
    throw new Error('Transport must be http, sse or stdio.');
  }
}

export async function listProjectMcpServers(projectId: string): Promise<McpServerView[]> {
  const rows = await prisma.projectMcpServer.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toView);
}

export async function createProjectMcpServer(projectId: string, input: McpServerInput): Promise<McpServerView> {
  const existing = await prisma.projectMcpServer.findMany({ where: { projectId }, select: { name: true } });
  await validateMcpInput(input, new Set(existing.map((e) => e.name)));
  const name = input.name.trim().toLowerCase();
  const row = await prisma.projectMcpServer.create({
    data: {
      projectId,
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
  return toView(row);
}

export async function updateProjectMcpServer(
  projectId: string, id: string, patch: Partial<McpServerInput>,
): Promise<McpServerView | null> {
  const row = await prisma.projectMcpServer.findFirst({ where: { id, projectId } });
  if (!row) return null;
  // Only `enabled` toggles are common; other edits re-validate the merged result.
  const data: Record<string, unknown> = {};
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  if (patch.label !== undefined) data.label = (patch.label || row.label).trim();
  if (patch.url !== undefined) data.url = patch.url ? patch.url.trim() : null;
  if (patch.command !== undefined) data.command = patch.command ? patch.command.trim() : null;
  if (patch.args !== undefined) data.argsJson = patch.args?.length ? JSON.stringify(patch.args) : null;
  if (patch.headers !== undefined) data.headersEncrypted = patch.headers && Object.keys(patch.headers).length ? encrypt(JSON.stringify(patch.headers)) : null;
  if (patch.env !== undefined) data.envEncrypted = patch.env && Object.keys(patch.env).length ? encrypt(JSON.stringify(patch.env)) : null;
  if ((patch.url !== undefined || patch.transport !== undefined) && (patch.transport ?? row.transport) !== 'stdio' && (patch.url ?? row.url)) {
    // Re-run the URL guard if the endpoint changed.
    try {
      const parsed = new URL((patch.url ?? row.url) as string);
      if (parsed.protocol !== 'https:') throw new Error('MCP server URL must use https://.');
      await assertHostAllowed(parsed.hostname);
    } catch (e) {
      throw e instanceof Error ? e : new Error('Invalid URL');
    }
  }
  const updated = await prisma.projectMcpServer.update({ where: { id: row.id }, data });
  return toView(updated);
}

export async function deleteProjectMcpServer(projectId: string, id: string): Promise<boolean> {
  const res = await prisma.projectMcpServer.deleteMany({ where: { id, projectId } });
  return res.count > 0;
}

/**
 * Build the enabled project MCP servers as a `{ name: McpEntry }` map, ready to
 * merge into the agent's mcpServers (both agent paths use the same shape).
 * Decrypts secrets — server-side only, never sent to the client.
 */
export async function buildProjectMcpConfig(projectId: string): Promise<Record<string, McpEntry>> {
  const rows = await prisma.projectMcpServer.findMany({ where: { projectId, enabled: true } });
  const out: Record<string, McpEntry> = {};
  for (const row of rows) {
    if (RESERVED_NAMES.has(row.name)) continue; // defensive
    if (row.transport === 'http' || row.transport === 'sse') {
      if (!row.url) continue;
      const headers = row.headersEncrypted ? parseJson<Record<string, string>>(decrypt(row.headersEncrypted), {}) : undefined;
      out[row.name] = { type: row.transport, url: row.url, ...(headers && Object.keys(headers).length ? { headers } : {}) };
    } else if (row.transport === 'stdio') {
      if (!row.command) continue;
      const env = row.envEncrypted ? parseJson<Record<string, string>>(decrypt(row.envEncrypted), {}) : undefined;
      out[row.name] = { command: row.command, args: parseJson<string[]>(row.argsJson, []), ...(env && Object.keys(env).length ? { env } : {}) };
    }
  }
  return out;
}
