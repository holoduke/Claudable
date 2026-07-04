/**
 * Network-MCP bridge for the CONTAINERIZED agent (target-architecture Phase 2).
 *
 * The in-process agent gets its 3 tool servers (appdiag / images / itops) as
 * in-process SDK MCP servers. The containerized agent has no access to this
 * process, so the SAME tool definitions are served over HTTP instead:
 *
 *   container --HTTPS--> /api/agent-mcp/<turn-token>/<server>   (streamable-HTTP MCP)
 *
 * Security model: a TURN TOKEN is a per-turn capability — 32 random bytes,
 * registered when the containerized turn starts, revoked when it ends, and
 * scoped to one project + the servers that turn is entitled to (itops only when
 * the requesting user has it enabled). The tools RUN IN THIS PROCESS, so their
 * credentials (xAI key, Gitea token, …) never enter the agent container — the
 * exact broker property the in-process MCP servers had.
 *
 * The endpoint is deliberately minimal: stateless JSON responses (the MCP
 * streamable-HTTP spec allows a plain application/json reply per POST; no SSE
 * stream, no server-initiated messages), supporting initialize / initialized /
 * ping / tools/list / tools/call — all the claude CLI needs for tool use.
 */
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { z } from 'zod';
import { diagnosticsToolDefs } from './diagnostics-mcp';
import { imagesToolDefs } from './images-mcp';
import { itopsToolDefs } from './itops/itops-mcp';

export type AgentMcpServerName = 'appdiag' | 'images' | 'itops';

interface AgentMcpTurn {
  projectId: string;
  projectPath: string;
  servers: AgentMcpServerName[];
  expiresAt: number;
}

// Turn tokens are in-memory on purpose: a turn never outlives the process, and
// a restart invalidating in-flight tokens is the safe failure mode.
const turns = new Map<string, AgentMcpTurn>();
const TURN_TTL_MS = 6 * 60 * 60 * 1000; // hard cap; normal turns are revoked explicitly

function sweepExpiredTurns(): void {
  const now = Date.now();
  for (const [token, turn] of turns) {
    if (turn.expiresAt < now) turns.delete(token);
  }
}

export function registerAgentMcpTurn(o: {
  projectId: string;
  projectPath: string;
  imagesOn: boolean;
  itopsEnabled: boolean;
}): { token: string; servers: AgentMcpServerName[] } {
  sweepExpiredTurns();
  const servers: AgentMcpServerName[] = [
    'appdiag',
    ...(o.imagesOn ? (['images'] as const) : []),
    ...(o.itopsEnabled ? (['itops'] as const) : []),
  ];
  const token = randomBytes(32).toString('hex');
  turns.set(token, {
    projectId: o.projectId,
    projectPath: o.projectPath,
    servers,
    expiresAt: Date.now() + TURN_TTL_MS,
  });
  return { token, servers };
}

export function releaseAgentMcpTurn(token: string): void {
  turns.delete(token);
}

function getTurn(token: string): AgentMcpTurn | undefined {
  sweepExpiredTurns();
  return turns.get(token);
}

/** Shape shared by the SDK's tool() output — enough for list + call. */
interface BridgedToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (args: never, extra: unknown) => Promise<unknown>;
}

function toolDefsFor(turn: AgentMcpTurn, server: string): BridgedToolDef[] | null {
  if (!(turn.servers as string[]).includes(server)) return null;
  switch (server as AgentMcpServerName) {
    case 'appdiag':
      return diagnosticsToolDefs(turn.projectId) as unknown as BridgedToolDef[];
    case 'images':
      return imagesToolDefs(turn.projectId, turn.projectPath) as unknown as BridgedToolDef[];
    case 'itops':
      return itopsToolDefs() as unknown as BridgedToolDef[];
    default:
      return null;
  }
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface AgentMcpRpcOutcome {
  status: number;
  body?: unknown;
}

const rpcResult = (id: number | string | null | undefined, result: unknown) => ({
  jsonrpc: '2.0' as const,
  id: id ?? null,
  result,
});

const rpcError = (id: number | string | null | undefined, code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  id: id ?? null,
  error: { code, message },
});

async function handleSingleRpc(
  turn: AgentMcpTurn,
  server: string,
  rpc: JsonRpcRequest,
): Promise<AgentMcpRpcOutcome> {
  const defs = toolDefsFor(turn, server);
  if (!defs) {
    return { status: 404, body: rpcError(rpc.id, -32001, `Unknown or unauthorized MCP server: ${server}`) };
  }

  const method = typeof rpc.method === 'string' ? rpc.method : '';

  // Notifications (no id) get an empty 202 per the streamable-HTTP spec.
  if (method.startsWith('notifications/')) {
    return { status: 202 };
  }

  switch (method) {
    case 'initialize': {
      const requested = (rpc.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return {
        status: 200,
        body: rpcResult(rpc.id, {
          protocolVersion: typeof requested === 'string' ? requested : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: `claudable-${server}`, version: '0.1.0' },
        }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(rpc.id, {}) };
    case 'tools/list': {
      const tools = defs.map((d) => ({
        name: d.name,
        description: d.description,
        inputSchema: z.toJSONSchema(z.object(d.inputSchema)),
      }));
      return { status: 200, body: rpcResult(rpc.id, { tools }) };
    }
    case 'tools/call': {
      const params = (rpc.params ?? {}) as { name?: unknown; arguments?: unknown };
      const def = defs.find((d) => d.name === params.name);
      if (!def) {
        return { status: 200, body: rpcError(rpc.id, -32602, `Unknown tool: ${String(params.name)}`) };
      }
      const parsed = z.object(def.inputSchema).safeParse(params.arguments ?? {});
      if (!parsed.success) {
        return { status: 200, body: rpcError(rpc.id, -32602, `Invalid arguments: ${parsed.error.message}`) };
      }
      try {
        const result = await def.handler(parsed.data as never, {});
        return { status: 200, body: rpcResult(rpc.id, result) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[AgentMCP] tool ${server}/${def.name} failed:`, error);
        return {
          status: 200,
          body: rpcResult(rpc.id, {
            content: [{ type: 'text', text: `Tool failed: ${message}` }],
            isError: true,
          }),
        };
      }
    }
    default:
      return { status: 200, body: rpcError(rpc.id, -32601, `Method not found: ${method}`) };
  }
}

/**
 * Handle one POST body for /api/agent-mcp/<token>/<server>. The token is the
 * credential (a per-turn capability); no session/cookie auth applies here.
 */
export async function handleAgentMcpRpc(
  token: string,
  server: string,
  body: unknown,
): Promise<AgentMcpRpcOutcome> {
  const turn = getTurn(token);
  if (!turn) {
    return { status: 401, body: rpcError(null, -32000, 'Invalid or expired agent turn token') };
  }
  if (Array.isArray(body)) {
    // Legacy JSON-RPC batch (2025-03-26): answer each; notifications produce no entry.
    const answers: unknown[] = [];
    for (const item of body) {
      const out = await handleSingleRpc(turn, server, (item ?? {}) as JsonRpcRequest);
      if (out.status !== 202 && out.body !== undefined) answers.push(out.body);
    }
    return answers.length ? { status: 200, body: answers } : { status: 202 };
  }
  if (!body || typeof body !== 'object') {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: expected a JSON-RPC message') };
  }
  return handleSingleRpc(turn, server, body as JsonRpcRequest);
}

/**
 * Prepare the per-turn MCP wiring for a containerized turn: register the turn
 * token and write the CLI's --mcp-config into the project's .claudable/ (the
 * only path both Claudable and the agent container can see). Returns null (=
 * run without tools) when no reachable base URL is configured.
 */
export async function prepareAgentMcpTurnConfig(o: {
  projectId: string;
  projectPath: string;
  imagesOn: boolean;
  itopsEnabled: boolean;
}): Promise<{ containerPath: string; token: string; cleanup: () => Promise<void> } | null> {
  // The container reaches Claudable via its PUBLIC url (sandbox egress allows
  // internet, not the host) — override with AGENT_MCP_BASE_URL if ever needed.
  const baseUrl = (process.env.AGENT_MCP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!baseUrl) {
    console.warn('[AgentMCP] No AGENT_MCP_BASE_URL / NEXT_PUBLIC_APP_URL set — containerized agent runs WITHOUT appdiag/images/itops tools');
    return null;
  }

  const { token, servers } = registerAgentMcpTurn(o);
  const config = {
    mcpServers: Object.fromEntries(
      servers.map((s) => [s, { type: 'http', url: `${baseUrl}/api/agent-mcp/${token}/${s}` }]),
    ),
  };

  const dir = path.join(o.projectPath, '.claudable');
  const filePath = path.join(dir, 'agent-mcp.json');
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(config, null, 2));
  } catch (error) {
    releaseAgentMcpTurn(token);
    console.error('[AgentMCP] Failed to write per-turn mcp-config:', error);
    return null;
  }

  return {
    containerPath: '/work/.claudable/agent-mcp.json',
    token,
    cleanup: async () => {
      releaseAgentMcpTurn(token);
      await fs.rm(filePath, { force: true });
    },
  };
}
