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
 * WIRED into executeClaude as the DEFAULT path whenever PREVIEW_ISOLATION is set
 * (or AGENT_CONTAINERIZED=true): the per-turn agent runs here, in a hardened
 * container with network-MCP for the in-process tools and session resume. The
 * in-process path (claude.ts) is the fallback for local dev without the infra.
 */
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'crypto';
import { CONTAINER_PLUGINS_MOUNT } from '@/lib/services/plugins';

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
  skillsHostPath?: string;              // HOST path of the global skills dir
  skillsContainerPath?: string;         // where to mount them — MUST equal the /work/.claude/skills symlink target
  pluginsHostPath?: string;             // HOST path of the shared plugins dir (marketplace clones), mounted read-only
  pluginDirs?: string[];                // in-container plugin roots → one --plugin-dir each (loaded for this turn only)
  settingSources?: string;              // --setting-sources value (e.g. "project,user"); enables skill loading
  systemPrompt?: string;                // REPLACES the CLI default (parity with the SDK's systemPrompt option)
  allowedTools?: string;                // restrict built-in tools (space-separated, e.g. "Read Write")
  env?: Record<string, string>;         // extra project env (already secret-free)
  memory?: string;                      // e.g. "2g"
  cpus?: string;                        // e.g. "2.0"
  timeoutMs?: number;                   // hang safety net (default 30 min)
  containerName?: string;               // named claudable-agent-* so the boot sweep can reap orphans
  /** 0600 tmp file carrying the OAuth token + project env. Keeps secrets OUT of
   *  the `docker run` argv, which any host user can read via /proc. Set by
   *  runAgentTurnContainerized; the inline `-e` fallback exists only for direct
   *  callers of buildAgentContainerArgs. */
  envFilePath?: string;
}

// The globally installed Claude Code CLI (Dockerfile: npm install -g
// @anthropic-ai/claude-code). Agent SDK <=0.2 shipped a vendored cli.js inside
// its package that was spawned here; 0.3 removed it, so the global binary is
// the only CLI in the image.
const CLI_IN_IMAGE = '/usr/local/bin/claude';

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
  ];
  // Secrets (OAuth token, project DB URLs) travel via a 0600 env-file the docker
  // CLIENT reads locally — never on the world-readable argv.
  if (o.envFilePath) {
    args.push('--env-file', o.envFilePath);
  } else {
    args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${o.oauthToken}`);
  }
  // Persistent HOME (session transcripts under ~/.claude → --resume works across
  // turns). Ephemeral /tmp fallback = amnesiac turns, kept for safety.
  const home = o.homeHostPath && o.homeHostPath.trim() ? o.homeHostPath.trim() : '';
  if (home) {
    args.push('-v', `${home}:/home/agent`, '-e', 'HOME=/home/agent');
  } else {
    args.push('-e', 'HOME=/tmp');
  }
  // Global skills (read-only) so the agent can `Skill` the same catalog the
  // in-process path gets (nuxt-ui, codebase-design, …). syncProjectSkills stages
  // the project's /work/.claude/skills as SYMLINKS into the Claudable home's
  // skills dir; we mount the real global skills at THAT target path so those
  // symlinks resolve inside the agent container (and the 'project' source loads
  // them alongside real project skills).
  if (o.skillsHostPath && o.skillsHostPath.trim() && o.skillsContainerPath && o.skillsContainerPath.trim()) {
    args.push('-v', `${o.skillsHostPath.trim()}:${o.skillsContainerPath.trim()}:ro`);
  }
  // Company plugins (read-only): the shared marketplace-clone dir is mounted at a
  // fixed path and each enabled plugin is loaded via the CLI's own --plugin-dir
  // (appended below). Only mount when both the host dir and at least one enabled
  // plugin dir are present, so an unconfigured instance changes nothing.
  if (o.pluginsHostPath && o.pluginsHostPath.trim() && o.pluginDirs && o.pluginDirs.length) {
    args.push('-v', `${o.pluginsHostPath.trim()}:${CONTAINER_PLUGINS_MOUNT}:ro`);
  }
  if (!o.envFilePath) {
    for (const [k, v] of Object.entries(o.env ?? {})) args.push('-e', `${k}=${v}`);
  }
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
  // The prompt is NOT passed as an argument (it would be visible in `ps` on the
  // host) — runAgentTurnContainerized pipes it via stdin, which `-p` reads to EOF.
  args.push(image, CLI_IN_IMAGE,
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions');
  if (o.model) args.push('--model', o.model);
  if (o.sessionId) args.push('--resume', o.sessionId);
  if (o.mcpConfigPath) args.push('--mcp-config', o.mcpConfigPath);
  if (o.strictMcpConfig) args.push('--strict-mcp-config');
  // Restrict the built-in tool surface when set (e.g. design generation only
  // needs "Read Write"), so a prompt-injected turn can't reach Bash/WebFetch to
  // exfiltrate the (possibly shared) OAuth token. Space-separated tool names.
  if (o.allowedTools && o.allowedTools.trim()) args.push('--allowedTools', o.allowedTools.trim());
  // Load skills: 'project' → /work/.claude/skills, 'user' → ~/.claude/skills (the
  // mounted global catalog). Without this the containerized CLI loads no skills.
  if (o.settingSources && o.settingSources.trim()) args.push('--setting-sources', o.settingSources.trim());
  // Company plugins — loaded from the read-only mount for THIS session only
  // (repeatable flag). Independent of --setting-sources; the CLI substitutes
  // ${CLAUDE_PLUGIN_ROOT} to each dir. Their commands become /<plugin>:<cmd>.
  for (const dir of o.pluginDirs ?? []) args.push('--plugin-dir', dir);
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
  // Secrets + project env go through a 0600 env-file (docker reads it client-side)
  // and the prompt through stdin — NEITHER may appear in the world-readable argv.
  // Env-file values are single-line by format; strip newlines defensively.
  const envFile = path.join(os.tmpdir(), `claudable-agent-env-${randomUUID().slice(0, 12)}`);
  const envLines = [
    `CLAUDE_CODE_OAUTH_TOKEN=${String(o.oauthToken).replace(/\r?\n/g, '')}`,
    ...Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, ' ')}`),
  ];
  fs.writeFileSync(envFile, envLines.join('\n') + '\n', { mode: 0o600 });
  const removeEnvFile = () => { try { fs.unlinkSync(envFile); } catch { /* already gone */ } };

  const child: ChildProcess = spawn('docker', buildAgentContainerArgs({ ...o, envFilePath: envFile }), { env: process.env });
  // `-p` reads the prompt from stdin to EOF; write it and close so the CLI starts
  // immediately (an open pipe would make it wait forever).
  child.stdin?.write(o.prompt);
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
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString();
    // Only the tail is ever surfaced (slice(-500)); cap to avoid unbounded growth
    // over a 30-minute chatty run.
    if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
  });

  // Stop the turn HARD. Killing the `docker run` CLIENT (SIGTERM to `child`) does
  // NOT reliably stop the container — the client can detach and leave the agent
  // (and its tool subprocesses, e.g. a running Bash/build) alive, so the UI shows
  // "stopped" while the agent keeps editing. Force-remove the NAMED container so
  // Stop/Esc (and the hang-timeout) actually halt the agent. Best-effort; the
  // docker CLI reaches the daemon via DOCKER_HOST (already in process.env).
  const killContainer = () => {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    if (o.containerName) {
      try {
        // Capture the outcome instead of firing blind: if the daemon rejects the
        // delete (e.g. a delete-restricted docker socket-proxy), the agent would
        // keep editing files while the UI reads "stopped" — surface that in logs
        // so the failure is diagnosable rather than silent.
        const rm = spawn('docker', ['rm', '-f', o.containerName], { env: process.env });
        let rmErr = '';
        rm.stderr?.on('data', (c: Buffer) => { rmErr += c.toString(); });
        rm.on('exit', (code) => {
          if (code !== 0) {
            console.error(`[ClaudeContainer] Failed to force-remove ${o.containerName} (exit ${code}). The agent may still be running. ${rmErr.slice(-300)}`);
          }
        });
        rm.on('error', (e) => {
          console.error(`[ClaudeContainer] docker rm -f ${o.containerName} could not spawn:`, e.message);
        });
        rm.unref();
      } catch (e) {
        console.error(`[ClaudeContainer] Failed to invoke docker rm for ${o.containerName}:`, e);
      }
    }
  };

  // Hang safety net: a wedged CLI/container must not pin the turn forever.
  const timeoutMs = o.timeoutMs ?? 30 * 60 * 1000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killContainer();
  }, timeoutMs);

  const done = new Promise<ContainerTurnResult>((resolve) => {
    child.on('error', (e) => { clearTimeout(timer); removeEnvFile(); resolve({ ok: false, code: null, error: e.message }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      removeEnvFile();
      if (buf.trim()) handleLine(buf); // flush any trailing partial line
      if (timedOut) {
        resolve({ ok: false, code, sessionId, error: `Agent turn timed out after ${Math.round(timeoutMs / 60000)} minutes.` });
        return;
      }
      resolve({ ok: code === 0, code, sessionId, error: code === 0 ? undefined : stderr.slice(-500) });
    });
  });

  return { done, abort: () => killContainer() };
}

/** Convenience: the sandbox-net default + the host path helper live here so callers
 *  don't reimplement them. */
export function defaultAgentSandboxNet(): string | undefined {
  return process.env.PREVIEW_SANDBOX_NETWORK?.trim() || undefined;
}

/**
 * Whether the containerized agent inherits the Claude account's MANAGED
 * CONNECTORS (Gmail, Drive, Calendar, Atlassian, …) in addition to Claudable's
 * own brokered tools — i.e. parity with `claude mcp list` in the CLI.
 *
 * When true we do NOT pass `--strict-mcp-config`, so the CLI merges the account
 * connectors with our `--mcp-config`. The sandbox net already allows public
 * internet (needed for the Anthropic API), so the connector endpoints are
 * reachable; the box's private network stays blocked. This intentionally
 * loosens the agent's isolation to the user's own account connectors.
 *
 * Default ON. Set AGENT_ACCOUNT_MCP_CONNECTORS=0 to restore strict isolation
 * (only Claudable's brokered tools + explicit per-project MCP servers).
 */
export function accountMcpConnectorsEnabled(): boolean {
  const v = process.env.AGENT_ACCOUNT_MCP_CONNECTORS;
  if (v === undefined || v.trim() === '') return true;
  return !/^(0|false|off|no)$/i.test(v.trim());
}
/** Translate an in-container /app/data path to the real host path for bind mounts. */
export function agentHostPath(p: string): string {
  const hostData = process.env.DATA_HOST_DIR;
  if (hostData && hostData.trim() && p.startsWith('/app/data')) {
    return path.join(hostData.trim(), path.relative('/app/data', p));
  }
  return p;
}
