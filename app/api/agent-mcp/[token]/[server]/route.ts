/**
 * Network-MCP endpoint for the CONTAINERIZED agent (streamable-HTTP, stateless).
 * POST /api/agent-mcp/[token]/[server]  — server ∈ appdiag | images | itops
 *
 * Auth: the [token] path segment IS the credential — a per-turn capability
 * registered by runContainerizedTurn and revoked when the turn ends (see
 * lib/services/agent-mcp-http.ts). No session auth applies (the agent container
 * has no cookies); middleware.ts lists this path as self-authorizing.
 */
import { NextRequest } from 'next/server';
import { handleAgentMcpRpc } from '@/lib/services/agent-mcp-http';

interface RouteContext {
  params: Promise<{ token: string; server: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { token, server } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON' } },
      { status: 400 },
    );
  }

  const outcome = await handleAgentMcpRpc(token, server, body);
  if (outcome.status === 202) {
    return new Response(null, { status: 202 });
  }
  return Response.json(outcome.body ?? null, { status: outcome.status });
}

// No SSE stream: the spec allows a server to reject GET; the claude CLI then
// speaks plain JSON request/response, which is all these tools need.
export function GET() {
  return new Response('Method Not Allowed', { status: 405 });
}
