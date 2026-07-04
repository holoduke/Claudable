/**
 * Phase 2 (control/data split): run a Claude agent turn inside a HARDENED,
 * ISOLATED container instead of in-process. The container has NO docker socket /
 * DOCKER_HOST (so a compromised/prompt-injected agent can't self-provision — the
 * hard boundary #5 demands), non-root, egress-locked to the sandbox net (internet
 * for the Anthropic API, but not the host/DBs/other projects), and only the
 * project bind-mounted at /work.
 *
 * Proven feasible on box1 (2026-07-03): `claude` CLI runs headless here and edits
 * the mounted project. This module packages that as a streaming runner.
 *
 * NOT YET WIRED into executeClaude — that swap (streaming → SSE, network-MCP for
 * the 3 tools, session resume) is the guarded next step. This module is dormant
 * (nothing imports it) so it carries zero risk to the live in-process agent path.
 */
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';

/** A parsed stream-json event from the CLI (system/assistant/tool_use/result …). */
export interface AgentStreamEvent {
  type: string;
  [k: string]: unknown;
}

export interface ContainerTurnOptions {
  projectHostPath: string;              // HOST path of the project (bind-mounted at /work)
  prompt: string;
  oauthToken: string;                   // CLAUDE_CODE_OAUTH_TOKEN (never persisted)
  model?: string;
  sessionId?: string;                   // resume a prior turn
  image?: string;                       // agent image (has the claude CLI)
  sandboxNet?: string;                  // egress-locked network name (primary; internet for the API)
  projectNet?: string;                  // the project's internal net (reach db/cache by alias) — attached at RUN
  mcpConfigPath?: string;               // path (in-container) to a --mcp-config json of NETWORK tools
  strictMcpConfig?: boolean;            // only use the given mcp-config (ignore any other sources)
  homeHostPath?: string;                // persistent per-project HOME (CLI session transcripts → --resume works across turns)
  systemPrompt?: string;                // REPLACES the CLI default (parity with the SDK's systemPrompt option)
  env?: Record<string, string>;         // extra project env (already secret-free)
  memory?: string;                      // e.g. "2g"
  cpus?: string;                        // e.g. "2.0"
  timeoutMs?: number;                   // hang safety net (default 30 min)
  containerName?: string;               // named claudable-agent-* so the boot sweep can reap orphans
}

const CLI_IN_IMAGE = '/app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js';

/** Build the `docker run` argv for one isolated agent turn. Hardened + no docker access. */
export function buildAgentContainerArgs(o: ContainerTurnOptions): string[] {
  const image = o.image || process.env.AGENT_IMAGE || 'claudable-claudable';
  const args = [
    'run', '--rm', '-i',
    ...(o.containerName ? ['--name', o.containerName] : []),
    '--user', '1000:1000',                       // non-root, matches the mounted project owner
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--memory', o.memory || '2g',
    '--cpus', String(o.cpus || '2.0'),
    '--pids-limit', '512',
    '-w', '/work',
    '-v', `${o.projectHostPath}:/work`,
    // HARD BOUNDARY: no docker socket, no DOCKER_HOST — the agent cannot reach the
    // control plane's Docker (can't self-provision). Egress-locked sandbox net only.
    '-e', `CLAUDE_CODE_OAUTH_TOKEN=${o.oauthToken}`,
  ];
  // Persistent HOME (session transcripts under ~/.claude → --resume works across
  // turns). Ephemeral /tmp fallback = amnesiac turns, kept for safety.
  if (o.homeHostPath && o.homeHostPath.trim()) {
    args.push('-v', `${o.homeHostPath.trim()}:/home/agent`, '-e', 'HOME=/home/agent');
  } else {
    args.push('-e', 'HOME=/tmp');
  }
  for (const [k, v] of Object.entries(o.env ?? {})) args.push('-e', `${k}=${v}`);
  // Attach BOTH networks at creation (docker 20.10+): the sandbox net for egress
  // to the Anthropic API (PRIMARY), and the project's internal net so `db`/`cache`
  // aliases resolve from the FIRST command — no post-spawn attach race.
  // GUARD: the project net is `--internal` (no gateway). Only attach it when the
  // sandbox net is ALSO present, else the agent would sit on an egress-less net
  // and couldn't reach the API. With no sandbox net, run on the default bridge
  // (egress ok, no DB reach) — the safe degrade.
  if (o.sandboxNet && o.sandboxNet.trim()) {
    args.push('--network', o.sandboxNet.trim());
    if (o.projectNet && o.projectNet.trim()) args.push('--network', o.projectNet.trim());
  }
  args.push(image, 'node', CLI_IN_IMAGE,
    '-p', o.prompt,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions');
  if (o.model) args.push('--model', o.model);
  if (o.sessionId) args.push('--resume', o.sessionId);
  if (o.mcpConfigPath) args.push('--mcp-config', o.mcpConfigPath);
  if (o.strictMcpConfig) args.push('--strict-mcp-config');
  if (o.systemPrompt) args.push('--system-prompt', o.systemPrompt);
  return args;
}

export interface ContainerTurnResult {
  ok: boolean;
  code: number | null;
  sessionId?: string;   // for resume
  error?: string;
}

/**
 * Run one agent turn in a container, streaming each stream-json event to `onEvent`.
 * Resolves when the turn ends. `abort` kills the container.
 */
export function runAgentTurnContainerized(
  o: ContainerTurnOptions,
  onEvent: (e: AgentStreamEvent) => void,
): { done: Promise<ContainerTurnResult>; abort: () => void } {
  const child: ChildProcess = spawn('docker', buildAgentContainerArgs(o), { env: process.env });
  // The CLI in -p mode still reads stdin to EOF (piped-prompt support); an open
  // pipe makes it wait FOREVER before starting. Close it so it sees EOF at once.
  child.stdin?.end();
  let sessionId: string | undefined;
  let stderr = '';
  let buf = '';

  const handleLine = (line: string) => {
    const t = line.trim();
    if (!t) return;
    try {
      const evt = JSON.parse(t) as AgentStreamEvent;
      // The CLI emits the session id on the init/system event and the final result.
      const sid = (evt as Record<string, unknown>).session_id;
      if (typeof sid === 'string') sessionId = sid;
      onEvent(evt);
    } catch {
      // Non-JSON diagnostic line — surface as a raw log event so nothing is lost.
      onEvent({ type: 'raw', text: t });
    }
  };

  child.stdout?.on('data', (c: Buffer) => {
    buf += c.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });

  // Hang safety net: a wedged CLI/container must not pin the turn forever.
  const timeoutMs = o.timeoutMs ?? 30 * 60 * 1000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }, timeoutMs);

  const done = new Promise<ContainerTurnResult>((resolve) => {
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: null, error: e.message }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (buf.trim()) handleLine(buf); // flush any trailing partial line
      if (timedOut) {
        resolve({ ok: false, code, sessionId, error: `Agent turn timed out after ${Math.round(timeoutMs / 60000)} minutes.` });
        return;
      }
      resolve({ ok: code === 0, code, sessionId, error: code === 0 ? undefined : stderr.slice(-500) });
    });
  });

  return { done, abort: () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } } };
}

/** Convenience: the sandbox-net default + the host path helper live here so callers
 *  don't reimplement them. */
export function defaultAgentSandboxNet(): string | undefined {
  return process.env.PREVIEW_SANDBOX_NETWORK?.trim() || undefined;
}
/** Translate an in-container /app/data path to the real host path for bind mounts. */
export function agentHostPath(p: string): string {
  const hostData = process.env.DATA_HOST_DIR;
  if (hostData && hostData.trim() && p.startsWith('/app/data')) {
    return path.join(hostData.trim(), path.relative('/app/data', p));
  }
  return p;
}
