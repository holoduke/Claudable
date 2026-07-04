import { describe, it, expect } from 'vitest';
import {
  registerAgentMcpTurn,
  releaseAgentMcpTurn,
  handleAgentMcpRpc,
} from './agent-mcp-http';

const rpc = (method: string, params?: Record<string, unknown>, id: number | null = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
});

describe('agent-mcp-http bridge', () => {
  it('scopes servers to the turn entitlements', () => {
    const { token, servers } = registerAgentMcpTurn({
      projectId: 'p1',
      projectPath: '/tmp/p1',
      imagesOn: false,
      itopsEnabled: false,
    });
    expect(servers).toEqual(['appdiag']);
    releaseAgentMcpTurn(token);

    const withAll = registerAgentMcpTurn({
      projectId: 'p1',
      projectPath: '/tmp/p1',
      imagesOn: true,
      itopsEnabled: true,
    });
    expect(withAll.servers).toEqual(['appdiag', 'images', 'itops']);
    releaseAgentMcpTurn(withAll.token);
  });

  it('rejects unknown or released tokens with 401', async () => {
    const bad = await handleAgentMcpRpc('nope', 'appdiag', rpc('initialize'));
    expect(bad.status).toBe(401);

    const { token } = registerAgentMcpTurn({
      projectId: 'p1',
      projectPath: '/tmp/p1',
      imagesOn: false,
      itopsEnabled: false,
    });
    releaseAgentMcpTurn(token);
    const released = await handleAgentMcpRpc(token, 'appdiag', rpc('initialize'));
    expect(released.status).toBe(401);
  });

  it('404s a server the turn is not entitled to', async () => {
    const { token } = registerAgentMcpTurn({
      projectId: 'p1',
      projectPath: '/tmp/p1',
      imagesOn: false,
      itopsEnabled: false,
    });
    const out = await handleAgentMcpRpc(token, 'itops', rpc('initialize'));
    expect(out.status).toBe(404);
    releaseAgentMcpTurn(token);
  });

  it('answers the MCP handshake + tool listing + tool call', async () => {
    const { token } = registerAgentMcpTurn({
      projectId: 'proj-mcp-test',
      projectPath: '/tmp/proj-mcp-test',
      imagesOn: false,
      itopsEnabled: false,
    });

    const init = await handleAgentMcpRpc(token, 'appdiag', rpc('initialize', { protocolVersion: '2025-06-18' }));
    expect(init.status).toBe(200);
    const initBody = init.body as { result: { protocolVersion: string; capabilities: { tools: object } } };
    expect(initBody.result.protocolVersion).toBe('2025-06-18');
    expect(initBody.result.capabilities.tools).toBeDefined();

    const notified = await handleAgentMcpRpc(token, 'appdiag', {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notified.status).toBe(202);

    const list = await handleAgentMcpRpc(token, 'appdiag', rpc('tools/list', {}, 2));
    expect(list.status).toBe(200);
    const tools = (list.body as { result: { tools: Array<{ name: string; inputSchema: { type: string } }> } }).result.tools;
    expect(tools.map((t) => t.name)).toContain('check_app_health');
    expect(tools[0].inputSchema.type).toBe('object');

    const call = await handleAgentMcpRpc(
      token,
      'appdiag',
      rpc('tools/call', { name: 'check_app_health', arguments: {} }, 3),
    );
    expect(call.status).toBe(200);
    const result = (call.body as { result: { content: Array<{ type: string; text: string }> } }).result;
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('No runtime diagnostics');

    const unknownTool = await handleAgentMcpRpc(
      token,
      'appdiag',
      rpc('tools/call', { name: 'does_not_exist', arguments: {} }, 4),
    );
    expect(unknownTool.status).toBe(200);
    expect((unknownTool.body as { error: { code: number } }).error.code).toBe(-32602);

    const unknownMethod = await handleAgentMcpRpc(token, 'appdiag', rpc('resources/list', {}, 5));
    expect((unknownMethod.body as { error: { code: number } }).error.code).toBe(-32601);

    releaseAgentMcpTurn(token);
  });

  it('rejects invalid tool arguments with -32602', async () => {
    const { token } = registerAgentMcpTurn({
      projectId: 'proj-args-test',
      projectPath: '/tmp/proj-args-test',
      imagesOn: false,
      itopsEnabled: false,
    });
    const out = await handleAgentMcpRpc(
      token,
      'appdiag',
      rpc('tools/call', { name: 'check_app_health', arguments: { limit: 'not-a-number' } }, 6),
    );
    expect(out.status).toBe(200);
    expect((out.body as { error: { code: number } }).error.code).toBe(-32602);
    releaseAgentMcpTurn(token);
  });
});
