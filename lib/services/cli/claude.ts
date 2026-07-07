/**
 * Claude Agent SDK Service - Claude Agent SDK Integration
 *
 * Interacts with projects using the Claude Agent SDK.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSession, ClaudeResponse } from '@/types/backend';
import { streamManager } from '../stream';
import { serializeMessage, createRealtimeMessage } from '@/lib/serializers/chat';
import { getProjectById } from '../project';
import { syncProjectSkills, hasDisabledSkills } from '../skills';
import { CLAUDE_SYSTEM_PROMPT } from './prompts/claude-system-prompt';
import { NEXT_SYSTEM_PROMPT } from './prompts/next-system-prompt';
import { ANGULAR_SYSTEM_PROMPT } from './prompts/angular-system-prompt';
import { STATIC_SYSTEM_PROMPT } from './prompts/static-system-prompt';
import { DOCUMENT_SYSTEM_PROMPT } from './prompts/document-system-prompt';
import { stackKind } from '@/lib/config/stacks';
import { resolveProjectClaudeToken } from '../claude-credentials';
import { buildItopsMcpServer } from '../itops/itops-mcp';
import { buildDiagnosticsMcpServer } from '../diagnostics-mcp';
import { runAgentTurnContainerized, agentHostPath, defaultAgentSandboxNet, accountMcpConnectorsEnabled, type AgentStreamEvent } from './claude-container';
import { attachAgentAbort, unregisterAgentRun } from './run-registry';
import { prepareAgentMcpTurnConfig } from '../agent-mcp-http';
import { buildProjectMcpConfig } from '../project-mcp';
import { buildSharedMcpConfig } from '../shared-mcp';
import { previewSlug, ensureProjectNetwork } from '../preview';
import { getInjectedEnv, ensureServicesRunning } from '../managed-containers';
import { buildImagesMcpServer, imagesEnabledFor } from '../images-mcp';
import { getProjectService } from '../project-services';
import { createMessage } from '../message';
import { CLAUDE_DEFAULT_MODEL, normalizeClaudeModelId, getClaudeModelDisplayName } from '@/lib/constants/claudeModels';
import path from 'path';
import os from 'os';
import { realpathSync } from 'fs';

/**
 * Persist + stream a visible "interrupted" marker so a stopped turn leaves a
 * trace in the transcript (CLI parity: Esc records that the turn was interrupted)
 * and it survives a reload. Best-effort — never throws into the caller.
 */
async function persistInterruptedMarker(projectId: string, requestId?: string): Promise<void> {
  try {
    const marker = await createMessage({
      projectId,
      role: 'system',
      messageType: 'info',
      content: '⏹ Request interrupted by user',
      cliSource: 'claude',
      ...(requestId ? { requestId } : {}),
    });
    streamManager.publish(projectId, {
      type: 'message',
      data: serializeMessage(marker, requestId ? { requestId } : undefined),
    });
  } catch (error) {
    console.error('[ClaudeService] Failed to persist interrupted marker:', error);
  }
}

/**
 * The environment handed to the agent subprocess. The SDK REPLACES the child
 * env with whatever we pass (it only falls back to `{...process.env}` when no
 * `env` is given), so this is an allowlist: the agent gets the infrastructure
 * vars + its own Claude/Anthropic auth, but NOT Claudable's secrets
 * (DATABASE_URL, GOOGLE_CLIENT_SECRET, GIT_TOKEN, AUTH_SECRET, …). This stops a
 * prompt-injected agent from `printenv`-ing the app's credentials.
 *
 * Generous on purpose: missing a var the CLI/npm/git needs would break runs, so
 * we keep all standard runtime vars and pass through anything prefixed CLAUDE_ or
 * ANTHROPIC_ (the agent's own config) while dropping everything else.
 */
const AGENT_ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
  'TMPDIR', 'TMP', 'TEMP', 'HOSTNAME', 'NODE_ENV', 'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'npm_config_registry', 'COREPACK_ENABLE_DOWNLOAD_PROMPT',
]);

/** The system prompt for a project's tech stack (Nuxt | Next.js | Angular | document | static import). */
function selectSystemPrompt(templateType: string | null | undefined): string {
  // 'document' shares the static serving path but is a print-first HTML document,
  // not an imported site — it gets its own authoring guidance.
  if (templateType === 'document') {
    return DOCUMENT_SYSTEM_PROMPT;
  }
  switch (stackKind(templateType)) {
    case 'static':
      return STATIC_SYSTEM_PROMPT;
    case 'next':
      return NEXT_SYSTEM_PROMPT;
    case 'angular':
      return ANGULAR_SYSTEM_PROMPT;
    default:
      return CLAUDE_SYSTEM_PROMPT;
  }
}

function buildAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (AGENT_ENV_ALLOW.has(key) || key.startsWith('CLAUDE_') || key.startsWith('ANTHROPIC_')) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Lightweight cross-project guard (NOT a full OS sandbox — see the deliberate
 * choice to keep this simple). A PreToolUse hook (which fires even under
 * bypassPermissions) denies tool calls that reach OUTSIDE the current project:
 * sibling projects under the projects root, Claudable's own source/secrets under
 * the app root, and a few sensitive system paths. The agent keeps full power
 * (tools, skills, file access, shell) within its own project + the temp dir.
 *
 * Heuristic by design: it catches the realistic "read/modify another project"
 * cases, not deliberate obfuscation (e.g. base64-encoded paths). Pairs with the
 * env scrub (buildAgentEnv) which already hides app secrets from `printenv`.
 */
function pathIsInside(childAbs: string, parentAbs: string): boolean {
  if (!parentAbs) return false;
  const rel = path.relative(parentAbs, childAbs);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// Container-runtime / docker-proxy access, denied in the agent's Bash. Matches a
// runtime invoked as a command, the DOCKER_HOST env, the docker socket, or the
// proxy's TCP port. Heuristic (consistent with bashEscape) — raises the bar
// against the host-escape the preview socket-proxy would otherwise enable.
const CONTAINER_RUNTIME =
  /(?:^|[\s;&|(`$])(?:docker|docker-compose|podman|nerdctl|ctr|crictl)(?:\s|$)|DOCKER_HOST|docker\.sock|\/var\/run\/docker|:237[56]\b/i;

function buildProjectGuardHook(projectAbsPath: string) {
  const projectsRoot = path.dirname(projectAbsPath); // e.g. /app/data/projects
  const appRoot = process.cwd();                     // Claudable app root (/app)
  const tmpDir = os.tmpdir();
  const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']);

  // Resolve symlinks so a symlinked ANCESTOR can't smuggle a path out of the
  // project (agent does `ln -s /app link` then reads `link/.env`). The target may
  // not exist yet (Write to a new file), so realpath the nearest existing
  // ancestor and re-append the rest.
  const realResolve = (abs: string): string => {
    let cur = abs;
    const tail: string[] = [];
    for (let i = 0; i < 64; i++) {
      try {
        const real = realpathSync.native(cur);
        return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) break; // hit the filesystem root
        tail.push(path.basename(cur));
        cur = parent;
      }
    }
    return abs;
  };
  const realProject = realResolve(projectAbsPath);
  const realTmp = realResolve(tmpDir);

  const pathAllowed = (p: string): boolean => {
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(projectAbsPath, p);
    const real = realResolve(abs);
    return pathIsInside(real, realProject) || pathIsInside(real, realTmp);
  };

  // Returns the offending token if a bash command reaches outside the project.
  const bashEscape = (command: string): string | null => {
    const tokens = command.match(/(?:\/[\w.+-]+){2,}/g) || []; // absolute path-ish tokens
    for (const tok of tokens) {
      const abs = path.resolve(tok);
      if (pathIsInside(abs, projectAbsPath)) continue; // own project — fine
      if (pathIsInside(abs, projectsRoot)) return tok;  // a sibling project
      if (pathIsInside(abs, appRoot)) return tok;       // Claudable source/secrets
      if (/^\/(etc|root|opt|boot|sys|proc\/\d)/.test(abs)) return tok; // sensitive system paths
    }
    // Relative cross-project reference like ../<other> or data/projects/<other>.
    const rel = command.match(/data\/projects\/([\w.-]+)/);
    if (rel && rel[1] !== path.basename(projectAbsPath)) return rel[0];
    // Relative traversal: the absolute-token regex above DROPS leading `..`, so a
    // token like `../other-project/.env` slipped through (it read `/other/.env`,
    // outside all roots → allowed) while the shell (cwd=project) actually reached
    // a sibling. Catch any `../`-containing token that escapes the project — this
    // also blocks `ln -s ../../.. up` style symlink-escape setup.
    for (const tok of command.match(/(?:\.\.\/)+[\w./+-]*/gu) || []) {
      if (!pathIsInside(path.resolve(projectAbsPath, tok), projectAbsPath)) return tok;
    }
    return null;
  };

  return async (input: any) => {
    const name = input?.tool_name as string;
    const ti = (input?.tool_input ?? {}) as Record<string, unknown>;
    const deny = (reason: string) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    });

    if (name === 'Bash' && typeof ti.command === 'string') {
      // Container-runtime access is a host-escape vector: Claudable can reach a
      // docker socket-proxy (for preview isolation), and `docker run -v /:/host`
      // from here would mount the host root. The agent never needs Docker — deny
      // any container-runtime command, the proxy endpoint, or the docker socket.
      if (CONTAINER_RUNTIME.test(ti.command)) {
        return deny('Container-runtime / Docker access is not available to the agent. Edit the project files; the preview runs them in an isolated environment.');
      }
      const bad = bashEscape(ti.command);
      if (bad) return deny(`Access outside this project is not allowed (path: ${bad}). Work only within the current project.`);
      return { continue: true };
    }

    if (FILE_TOOLS.has(name)) {
      for (const key of ['file_path', 'path', 'notebook_path']) {
        const v = ti[key];
        if (typeof v === 'string' && !pathAllowed(v)) {
          return deny(`"${v}" is outside the current project. The agent may only access this project's files.`);
        }
      }
    }

    return { continue: true };
  };
}
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import {
  markUserRequestAsRunning,
  markUserRequestAsCompleted,
  markUserRequestAsFailed,
} from '@/lib/services/user-requests';

import { buildToolMetadata } from './tool-metadata';
// Shared message handling (placeholder protocol, tool cards, thinking blocks,
// session persistence) — used by BOTH the in-process loop below and the
// containerized runner, so both render identical chat output.
import {
  createAgentMessageProcessor,
  dispatchToolMessage,
  handleToolPlaceholderMessage,
} from './agent-messages';

function resolveModelId(model?: string | null): string {
  return normalizeClaudeModelId(model);
}

/**
 * Execute command using Claude Agent SDK
 *
 * @param projectId - Project ID
 * @param projectPath - Project directory path
 * @param instruction - Command to pass to AI
 * @param model - Claude model to use (default: claude-sonnet-4-6)
 * @param sessionId - Previous session ID (maintains conversation context)
 * @param requestId - (Optional) User request tracking ID
 */
/**
 * How much extended thinking the agent should use.
 * - 'off'    — no extended thinking (fastest)
 * - 'auto'   — adaptive; Claude decides when/how much to think (default)
 * - 'forced' — adaptive with high effort: deep reasoning every turn
 *
 * We use adaptive thinking (+ effort) rather than an explicit `budgetTokens`
 * because a fixed budget must stay below maxOutputTokens (the API rejects
 * budget >= max_tokens); adaptive has no such constraint and is the SDK's
 * recommended control on modern models.
 */
export type ThinkingMode = 'off' | 'auto' | 'forced';

function buildThinkingOptions(mode: ThinkingMode | undefined): {
  thinking: { type: 'disabled' } | { type: 'adaptive' };
  effort?: 'low' | 'medium' | 'high' | 'max';
} {
  switch (mode) {
    case 'off':
      return { thinking: { type: 'disabled' } };
    case 'forced':
      return { thinking: { type: 'adaptive' }, effort: 'high' };
    case 'auto':
    default:
      return { thinking: { type: 'adaptive' } };
  }
}

/**
 * The agent's system prompt for a project + the images capability flag it
 * implies. Shared by the in-process path and the containerized path so both
 * agents get IDENTICAL instructions (stack prompt, model identity, appdiag,
 * image generation, database note).
 */
async function buildAgentSystemPrompt(
  projectId: string,
  modelLabel: string,
  resolvedModel: string,
): Promise<{ systemPrompt: string; imagesOn: boolean }> {
  // Pick the system prompt for the project's tech stack (Nuxt | Next.js | Angular).
  const stackProject = await getProjectById(projectId).catch(() => null);
  // Image generation available when the project (or Claudable) has an xAI key.
  const imagesOn = await imagesEnabledFor(projectId).catch(() => false);
  let systemPrompt = selectSystemPrompt(stackProject?.templateType);

  // Tell the agent which model it's running as — otherwise it guesses its own
  // version wrong (e.g. answering "4.6" when the user selected Fable 5).
  systemPrompt += `\n\nYou are running as ${modelLabel} (model id \`${resolvedModel}\`). If asked which model you are, answer with this.`;

  // Tell the agent about the live diagnostics tool so it verifies its own work
  // and can act on real runtime errors instead of guessing.
  systemPrompt += `\n\n## Checking the running app\nYou have a tool \`mcp__appdiag__check_app_health\` that returns the CURRENTLY RUNNING preview's uncaught browser errors, console errors/warnings, and Nuxt backend (server) errors. Use it to:\n- verify a change actually works after you edit (check for new errors before saying you're done),\n- investigate when the user reports something is broken,\n- find real bugs to fix proactively.\nAn empty result means nothing has been reported since the preview last started — it is not proof the app is bug-free; exercise the feature in the preview, then check again.`;

  if (imagesOn) {
    systemPrompt += `\n\n## Generating images\nYou have a tool \`mcp__images__generate_image\` that generates an image from a text prompt and saves it into the project's public/generated/, returning a path like \`/generated/hero.png\`. Use it whenever the app needs a REAL image (hero, illustration, avatar, texture, background) instead of a placeholder or an external stock URL, then reference the returned path directly in the markup. Write vivid, specific prompts.`;
  }

  // If a Postgres was provisioned for this project, tell the agent so it builds
  // data-backed features against DATABASE_URL (set in the preview + deploy env).
  try {
    const dbSvc = await getProjectService(projectId, 'database');
    if ((dbSvc?.serviceData as { engine?: string } | undefined)?.engine === 'postgresql') {
      systemPrompt += `\n\n## Database\nThis project has a PostgreSQL database. Its connection string is in the DATABASE_URL environment variable (already set in the running preview). Use it for any data persistence — prefer Prisma (schema datasource \`url = env("DATABASE_URL")\`, run \`prisma db push\`) or Drizzle/pg. Never hardcode credentials; always read DATABASE_URL from the environment.`;
    }
  } catch { /* non-fatal */ }

  return { systemPrompt, imagesOn };
}

/**
 * Phase 2 (control/data split): run the turn in a HARDENED ISOLATED CONTAINER
 * (no docker socket → the agent can't self-provision) instead of in-process.
 * Gated by AGENT_CONTAINERIZED (default off → the in-process path is used,
 * unchanged). Full parity: the same system prompt, the same message pipeline
 * (thinking blocks + tool cards via the shared processor), session resume, and
 * the 3 tools (appdiag/images/itops) reachable over network-MCP with a
 * per-turn capability token. Proven feasible on box1.
 */
async function runContainerizedTurn(args: {
  projectId: string;
  projectPath: string;
  instruction: string;
  resolvedModel: string;
  modelLabel: string;
  sessionId?: string;
  requestId?: string;
  itopsEnabled: boolean;
  /** Who triggered the run — gates private-credential use (see resolveProjectClaudeToken). */
  requesterUserId?: string;
  suppressUserError: boolean;
  publishStatus: (status: string, message?: string) => void;
  safeMarkRunning: () => Promise<void>;
  safeMarkCompleted: () => Promise<void>;
  safeMarkFailed: (message?: string) => Promise<void>;
}): Promise<void> {
  const { projectId, projectPath, instruction, resolvedModel, modelLabel, sessionId, requestId } = args;

  args.publishStatus('starting', 'Starting isolated agent container...');
  await args.safeMarkRunning();

  let mcp: Awaited<ReturnType<typeof prepareAgentMcpTurnConfig>> = null;
  try {
    const project = await getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}. Cannot create messages for non-existent project.`);
    }

    const { systemPrompt, imagesOn } = await buildAgentSystemPrompt(projectId, modelLabel, resolvedModel);

    // Credential: the project's assigned Claude token, falling back to the global env.
    let oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
    try {
      const projectToken = await resolveProjectClaudeToken(projectId, args.requesterUserId);
      if (projectToken) oauthToken = projectToken;
    } catch (e) {
      console.error('[ClaudeContainer] Failed to resolve project Claude credential:', e);
    }
    if (!oauthToken) {
      throw new Error('No Claude credential available (CLAUDE_CODE_OAUTH_TOKEN unset and no project credential).');
    }

    const absoluteProjectPath = path.isAbsolute(projectPath)
      ? path.resolve(projectPath)
      : path.resolve(process.cwd(), projectPath);
    const projectHostPath = agentHostPath(absoluteProjectPath);

    // Persistent per-project HOME so the CLI's session transcripts (~/.claude)
    // survive between turns — without this every containerized turn is amnesiac
    // and --resume can never find its session. Lives under DATA_DIR (not in the
    // project repo, so checkpoints stay clean); must be writable by uid 1000.
    let homeHostPath: string | undefined;
    let homeLocalPath: string | undefined;
    try {
      const homesRoot = path.resolve(process.cwd(), 'data', 'agent-homes');
      const homeDir = path.join(homesRoot, projectId);
      await fs.mkdir(homeDir, { recursive: true });
      // Owner-only: the app and the agent container both run as uid 1000, so 700
      // suffices — transcripts must not be readable (or writable: CLAUDE.md
      // poisoning) by other host users. Parent locked too so new files inside
      // stay unreachable regardless of their own mode. Best-effort — the real
      // test is the write probe below.
      await fs.chmod(homesRoot, 0o700).catch(() => {});
      await fs.chmod(homeDir, 0o700).catch(() => {});
      // Verify the dir is actually WRITABLE by us before committing to it — a
      // chmod that failed (e.g. root-owned dir) must not silently make every turn
      // amnesiac. Probe with a real write; only fall back to /tmp if it fails.
      const probe = path.join(homeDir, '.write-probe');
      await fs.writeFile(probe, '');
      await fs.rm(probe, { force: true });
      homeHostPath = agentHostPath(homeDir); // HOST path — only valid as a docker -v source
      homeLocalPath = homeDir;               // path WE can write (inside the Claudable container)
    } catch (e) {
      console.error('[ClaudeContainer] Agent home not writable — running amnesiac (no --resume):', e);
    }

    // Global skills so the containerized agent has the SAME `Skill` catalog as the
    // in-process path (nuxt-ui, codebase-design, …). We mount the global-skills host
    // volume (compose: ./global-skills → <claudableHome>/.claude/skills) read-only at
    // THAT SAME target path in the agent container, then syncProjectSkills stages the
    // project's /work/.claude/skills as symlinks to it (respecting per-project skill
    // disabling) + real project skills, so the 'project' source loads them all.
    // GUARD: only stage the global symlinks when the mount will actually be present,
    // else they'd dangle inside the container (no DATA_HOST_DIR → no mount).
    const skillsContainerPath = path.join(os.homedir(), '.claude', 'skills'); // = the symlink target
    let skillsHostPath: string | undefined;
    const skillsEnv = process.env.GLOBAL_SKILLS_HOST_DIR?.trim();
    const dataHost = process.env.DATA_HOST_DIR?.trim();
    if (skillsEnv) skillsHostPath = skillsEnv;
    else if (dataHost) skillsHostPath = path.join(path.dirname(dataHost), 'global-skills');
    if (skillsHostPath) await syncProjectSkills(projectId).catch(() => {});

    // The 3 in-process tools become NETWORK tools: registered under a per-turn
    // capability token, served by /api/agent-mcp/<token>/<server>, revoked below.
    mcp = await prepareAgentMcpTurnConfig({
      projectId,
      projectPath: absoluteProjectPath,
      imagesOn,
      itopsEnabled: args.itopsEnabled,
      // Write the per-turn token file into the HOME dir via the LOCAL path
      // (homeHostPath is the docker-mount source on the HOST — Claudable's own
      // process cannot write there when DATA_HOST_DIR points outside /app).
      homeLocalPath,
    });

    const processor = createAgentMessageProcessor({
      projectId,
      requestId,
      publishStatus: args.publishStatus,
      markCompleted: args.safeMarkCompleted,
    });

    // stream-json events arrive on stdout; chain handling onto a queue so
    // messages persist + publish strictly in order. Capture the final result's
    // SUBTYPE: 'success' means the turn genuinely produced its answer (incl. a
    // usage-policy refusal, which the CLI reports as success); anything else
    // ('error_during_execution', 'error_max_turns', …) is a real turn failure.
    let sawResult = false;
    let resultSubtype: string | undefined;
    let queue: Promise<void> = Promise.resolve();
    const onEvent = (e: AgentStreamEvent) => {
      if (e.type === 'result' && typeof (e as { subtype?: unknown }).subtype === 'string') {
        resultSubtype = (e as { subtype?: string }).subtype;
      }
      queue = queue
        .then(() => processor.processMessage(e as Parameters<typeof processor.processMessage>[0]))
        .then((kind) => {
          if (kind === 'result') sawResult = true;
        })
        .catch((err) => console.error('[ClaudeContainer] event handling failed:', err));
    };

    // The project's own managed containers (DB, cache, …) are reachable by alias
    // once the agent joins the project net below — hand it their connection env
    // (DATABASE_URL, REDIS_URL, …) so it can run migrations / seed / integrate
    // against the same services the app uses. Generic: whatever the services expose.
    // Also ENSURE those containers are running: the agent may need the DB with no
    // preview active (e.g. a migration), and startServices is a cheap no-op when
    // there are none or they're already up.
    let agentEnv: Record<string, string> = {};
    try {
      await ensureServicesRunning(projectId);
      agentEnv = await getInjectedEnv(projectId);
    } catch { /* non-fatal */ }

    // Target architecture: the agent joins its PROJECT's own internal network
    // (claudable-proj-<slug>) so it reaches ONLY this project's containers
    // (frontend/backend/db/cache by alias) — isolated from every other project,
    // while staying on the egress-locked sandbox net for the Anthropic API.
    // Ensure the net EXISTS before the run and attach it at creation (below), so
    // `db`/`cache` resolve from the agent's first command — no post-spawn race.
    // The --internal project net has no gateway → intra-project reach without egress.
    let projectNet: string | undefined;
    try { projectNet = await ensureProjectNetwork(projectId); }
    catch (e) { console.error('[ClaudeContainer] ensureProjectNetwork failed:', e); }

    args.publishStatus('ready', 'Project verified. Starting AI...');
    // Named so the boot sweep reaps it if this process dies mid-turn. A random
    // suffix makes it collision-proof for concurrent turns.
    const containerName = `claudable-agent-${previewSlug(projectId)}-${randomUUID().slice(0, 8)}`;
    let interruptedByUser = false;
    const { done, abort } = runAgentTurnContainerized(
      {
        projectHostPath,
        prompt: instruction,
        oauthToken,
        model: resolvedModel,
        sessionId,
        sandboxNet: defaultAgentSandboxNet(),
        projectNet,
        systemPrompt,
        mcpConfigPath: mcp?.containerPath,
        // Strict = ONLY our brokered config. When account-connector passthrough
        // is on (default), stay non-strict so the CLI also loads the user's
        // Claude account managed connectors (Gmail/Drive/Atlassian/…), matching
        // `claude mcp list`. NOTE: non-strict + settingSources 'project,user' also
        // lets a project's own `.mcp.json` / `.claude` settings load MCP servers.
        // That is NOT a new privilege: this agent already runs bypassPermissions
        // with Bash, so any stdio server it could plant runs at a privilege it
        // already holds, and http servers use the same egress its `curl` already
        // has. Isolation is enforced at the CONTAINER/NETWORK layer (egress-locked
        // sandbox net, per-project FS, scrubbed secrets), not by this flag. Set
        // AGENT_ACCOUNT_MCP_CONNECTORS=0 to restore strict (brokered-only) mode.
        strictMcpConfig: Boolean(mcp) && !accountMcpConnectorsEnabled(),
        homeHostPath,
        skillsHostPath,
        skillsContainerPath,
        // 'project' loads /work/.claude/skills (real project skills + the staged
        // global symlinks that now resolve to the mounted skills); 'user' is a
        // harmless belt-and-suspenders for anything in the agent HOME.
        settingSources: 'project,user',
        containerName,
        env: agentEnv,
      },
      onEvent,
    );

    // Expose this turn to the Stop endpoint (Esc-style interrupt). The flag lets
    // the failure path below tell "user pressed Stop" apart from a real crash.
    attachAgentAbort(projectId, requestId, () => {
      interruptedByUser = true;
      abort();
    });

    let result: Awaited<typeof done>;
    try {
      result = await done;
    } finally {
      unregisterAgentRun(projectId, requestId);
    }
    await queue; // flush in-flight message handling before finishing the turn

    if (interruptedByUser) {
      await persistInterruptedMarker(projectId, requestId);
      await args.safeMarkFailed('Stopped by user');
      args.publishStatus('completed', 'Stopped by user');
      console.log('[ClaudeContainer] Turn stopped by user');
      return;
    }

    // Success = the CLI reported a `result` with subtype 'success' (this covers a
    // usage-policy refusal, which still "succeeds" at producing its message). A
    // nonzero exit, a non-success subtype (e.g. 'error_during_execution' from a
    // stale --resume), or no result at all is a REAL failure → throw so
    // applyChanges can retry with a fresh session and the user isn't left with a
    // silent dead turn.
    const turnSucceeded = resultSubtype === 'success';
    if (!turnSucceeded) {
      throw new Error(
        result.error?.trim() ||
        (resultSubtype ? `Agent turn failed (${resultSubtype}).` : `Agent container exited with code ${result.code}.`),
      );
    }

    // The CLI's final `result` event already published completed + marked the
    // request; these are idempotent fallbacks for a turn that ended without one.
    if (!sawResult) args.publishStatus('completed');
    await args.safeMarkCompleted();
    console.log('[ClaudeContainer] Turn completed');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ClaudeContainer] Turn failed:', errorMessage);

    // When this attempt will be retried (e.g. a failed session resume), stay
    // silent so the user doesn't see a spurious error — just rethrow.
    if (args.suppressUserError) {
      throw new Error(errorMessage);
    }

    await args.safeMarkFailed(errorMessage);
    args.publishStatus('error', errorMessage);

    // Persist + stream a visible error message so it shows up in the chat log.
    try {
      const errorChatMessage = await createMessage({
        projectId,
        role: 'assistant',
        messageType: 'error',
        content: errorMessage,
        cliSource: 'claude',
      });
      streamManager.publish(projectId, {
        type: 'message',
        data: serializeMessage(errorChatMessage, requestId ? { requestId } : undefined),
      });
    } catch (persistError) {
      console.error('[ClaudeContainer] Failed to persist error message:', persistError);
    }

    streamManager.publish(projectId, {
      type: 'error',
      error: errorMessage,
      data: requestId ? { requestId } : undefined,
    });
    throw new Error(errorMessage);
  } finally {
    // Revoke the turn's tool token + remove the mcp-config from the project.
    if (mcp) {
      await mcp.cleanup().catch((e) => console.error('[ClaudeContainer] MCP cleanup failed:', e));
    }
  }
}

export async function executeClaude(
  projectId: string,
  projectPath: string,
  instruction: string,
  model: string = CLAUDE_DEFAULT_MODEL,
  sessionId?: string,
  requestId?: string,
  options: { suppressUserError?: boolean; thinkingMode?: ThinkingMode; requesterItopsEnabled?: boolean; requesterUserId?: string } = {}
): Promise<void> {
  console.log(`\n========================================`);
  console.log(`[ClaudeService] 🚀 Starting Claude Agent SDK`);
  console.log(`[ClaudeService] Project: ${projectId}`);
  const resolvedModel = resolveModelId(model);
  const modelLabel = getClaudeModelDisplayName(resolvedModel);
  const aliasNote = resolvedModel !== model ? ` (alias for ${model})` : '';
  console.log(`[ClaudeService] Model: ${modelLabel} [${resolvedModel}]${aliasNote}`);
  console.log(`[ClaudeService] Session ID: ${sessionId || 'new session'}`);
  console.log(`[ClaudeService] Instruction: ${instruction.substring(0, 100)}...`);
  console.log(`========================================\n`);

  const configuredMaxTokens = Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);
  const maxOutputTokens = Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0
    ? configuredMaxTokens
    : 4000;

  let hasMarkedTerminalStatus = false;
  let emittedCompletedStatus = false;

  const safeMarkRunning = async () => {
    if (!requestId) return;
    try {
      await markUserRequestAsRunning(requestId);
    } catch (error) {
      console.error(`[ClaudeService] Failed to mark request ${requestId} as running:`, error);
    }
  };

  const safeMarkCompleted = async () => {
    if (!requestId || hasMarkedTerminalStatus) return;
    try {
      await markUserRequestAsCompleted(requestId);
    } catch (error) {
      console.error(`[ClaudeService] Failed to mark request ${requestId} as completed:`, error);
    } finally {
      hasMarkedTerminalStatus = true;
    }
  };

  const safeMarkFailed = async (message?: string) => {
    if (!requestId || hasMarkedTerminalStatus) return;
    try {
      await markUserRequestAsFailed(requestId, message);
    } catch (error) {
      console.error(`[ClaudeService] Failed to mark request ${requestId} as failed:`, error);
    } finally {
      hasMarkedTerminalStatus = true;
    }
  };

  const publishStatus = (status: string, message?: string) => {
    streamManager.publish(projectId, {
      type: 'status',
      data: {
        status,
        ...(message ? { message } : {}),
        ...(requestId ? { requestId } : {}),
      },
    });
  };

  // Phase 2 (control/data split): run the turn in a HARDENED ISOLATED container
  // (no docker access → can't self-provision) instead of in-process.
  // DEFAULT: on wherever the container infra exists (PREVIEW_ISOLATION set) — this
  // is now the standard path. AGENT_CONTAINERIZED overrides explicitly either way
  // ('false' forces in-process even with isolation; 'true' forces containers).
  // Local dev without the infra falls back to in-process automatically.
  const containerizeFlag = process.env.AGENT_CONTAINERIZED?.trim();
  const containerize = containerizeFlag
    ? containerizeFlag === 'true'
    : Boolean(process.env.PREVIEW_ISOLATION?.trim());
  if (containerize) {
    await runContainerizedTurn({
      projectId,
      projectPath,
      instruction,
      resolvedModel,
      modelLabel,
      sessionId,
      requestId,
      itopsEnabled: options.requesterItopsEnabled === true,
      requesterUserId: options.requesterUserId,
      suppressUserError: options.suppressUserError === true,
      publishStatus,
      safeMarkRunning,
      safeMarkCompleted,
      safeMarkFailed,
    });
    return;
  }

  // Send start notification via SSE
  publishStatus('starting', 'Initializing Claude Agent SDK...');

  await safeMarkRunning();

  // Collect stderr from SDK process for better diagnostics
  const stderrBuffer: string[] = [];

  // Esc-style interrupt: the Stop endpoint (via the run registry) aborts this
  // controller, which the SDK honors mid-turn.
  const abortController = new AbortController();

  let currentSessionId: string | undefined = sessionId;

  // Shared message handler (system/init, assistant, result) + the placeholder/
  // tool-card dedupe state the partial-streaming branch below reuses.
  const processor = createAgentMessageProcessor({
    projectId,
    requestId,
    onSessionId: (sid) => { currentSessionId = sid; },
    publishStatus,
    markCompleted: safeMarkCompleted,
  });
  const { markPlaceholderHandled, persistedToolMessageSignatures, completedStreamSessions } = processor;
  void currentSessionId; // kept for parity/debugging (assigned via onSessionId)

  interface AssistantStreamState {
    messageId: string;
    content: string;
    hasSentUpdate: boolean;
    finalized: boolean;
  }

  // Hoisted to function scope so the abort (Stop) handler can flush partial
  // streamed text that message_stop never got to persist — otherwise text the
  // user already saw vanishes on reload.
  const assistantStreamStates = new Map<string, AssistantStreamState>();

  try {
    // Verify project exists (prevents foreign key constraint errors)
    console.log(`[ClaudeService] 🔍 Verifying project exists...`);
    const project = await getProjectById(projectId);
    if (!project) {
      const errorMessage = `Project not found: ${projectId}. Cannot create messages for non-existent project.`;
      console.error(`[ClaudeService] ❌ ${errorMessage}`);

      streamManager.publish(projectId, {
        type: 'error',
        error: errorMessage,
        data: requestId ? { requestId } : undefined,
      });

      throw new Error(errorMessage);
    }

    console.log(`[ClaudeService] ✅ Project verified: ${project.name}`);

    // Validate and prepare project path
    console.log(`[ClaudeService] 🔒 Validating project path...`);

    // Convert to absolute path
    const absoluteProjectPath = path.isAbsolute(projectPath)
      ? path.resolve(projectPath)
      : path.resolve(process.cwd(), projectPath);

    // Stack prompt + model identity + tool/database guidance — shared with the
    // containerized path so both agents get IDENTICAL instructions.
    const { systemPrompt: systemPromptForStack, imagesOn } = await buildAgentSystemPrompt(
      projectId,
      modelLabel,
      resolvedModel,
    );

    // it-ops follows the USER running the agent, NOT the project: attach the broker
    // only when the person who triggered this run has it-ops enabled. A different
    // user opening the same project gets no tools unless they too have it-ops.
    const itopsEnabled = options.requesterItopsEnabled === true;

    // Resolve the Claude credential for this project (a user's connected token),
    // falling back to the global env token. Built here so it overrides the scrubbed
    // CLAUDE_CODE_OAUTH_TOKEN in the agent env below.
    const agentEnv = buildAgentEnv();
    try {
      const projectToken = await resolveProjectClaudeToken(projectId, options.requesterUserId);
      if (projectToken) agentEnv.CLAUDE_CODE_OAUTH_TOKEN = projectToken;
    } catch (e) {
      console.error('[ClaudeService] Failed to resolve project Claude credential:', e);
    }

    // Security: Verify project path is within allowed directory
    const allowedBasePath = path.resolve(process.cwd(), process.env.PROJECTS_DIR || './data/projects');
    const relativeToBase = path.relative(allowedBasePath, absoluteProjectPath);
    const isWithinBase =
      !relativeToBase.startsWith('..') && !path.isAbsolute(relativeToBase);
    if (!isWithinBase) {
      const errorMessage = `Security violation: Project path must be within ${allowedBasePath}. Got: ${absoluteProjectPath}`;
      console.error(`[ClaudeService] ❌ ${errorMessage}`);

      streamManager.publish(projectId, {
        type: 'error',
        error: errorMessage,
        data: requestId ? { requestId } : undefined,
      });

      throw new Error(errorMessage);
    }

    // Check project directory exists and create if needed
    try {
      await fs.access(absoluteProjectPath);
      console.log(`[ClaudeService] ✅ Project directory exists: ${absoluteProjectPath}`);
    } catch {
      console.log(`[ClaudeService] 📁 Creating project directory: ${absoluteProjectPath}`);
      await fs.mkdir(absoluteProjectPath, { recursive: true });
    }

    // Send ready notification via SSE
    publishStatus('ready', 'Project verified. Starting AI...');

    // Skill loading. By default (no per-project customization) keep the original
    // behavior: auto-load project skills (<project>/.claude/skills) AND global
    // skills (~/.claude/skills) via settingSources ['project','user']. As soon as
    // the user disables any skill, switch to a staged model: stage just the
    // enabled skills into <project>/.claude/skills and load only the 'project'
    // source, so a disabled skill (project or global) is simply not present.
    // This keeps untouched projects byte-for-byte unchanged.
    const skillSettingSources: ('project' | 'user' | 'local')[] = (await hasDisabledSkills(projectId))
      ? ['project']
      : ['project', 'user'];
    if (skillSettingSources.length === 1) {
      await syncProjectSkills(projectId);
    }

    // Start Claude Agent SDK query
    console.log(`[ClaudeService] 🤖 Querying Claude Agent SDK...`);
    console.log(`[ClaudeService] 📁 Working Directory: ${absoluteProjectPath}`);
    attachAgentAbort(projectId, requestId, () => abortController.abort());

    // Per-project user-defined MCP servers (Project Settings → MCP) + org-shared
    // servers (the "company" tier, auto-attached to every project), merged into
    // the built-in brokered ones below. Best-effort — a bad row never blocks a run.
    // Project name wins over a shared one on collision.
    const [projectMcpServers, sharedMcpServers] = await Promise.all([
      buildProjectMcpConfig(projectId).catch(() => ({})),
      buildSharedMcpConfig(projectId).catch(() => ({})),
    ]);

    const response = query({
      prompt: instruction,
      options: {
        abortController,
        cwd: absoluteProjectPath, // SDK uses `cwd` (workingDirectory is ignored); without this the agent edits Claudable's own /app
        workingDirectory: absoluteProjectPath, // Work only in project folder (protects Claudable root)
        additionalDirectories: [absoluteProjectPath],
        // Replace the child env with a scrubbed allowlist so the agent can't read
        // Claudable's secrets (DB/Google/Git/Auth) via `printenv`. CLAUDE_CODE_OAUTH_TOKEN
        // is overridden above with the project's assigned credential when set.
        env: agentEnv,
        // Lightweight cross-project guard: block tool calls that escape this
        // project (other projects / app source / secrets). See buildProjectGuardHook.
        hooks: {
          PreToolUse: [{ hooks: [buildProjectGuardHook(absoluteProjectPath)] }],
        },
        // it-ops tools (in-process MCP broker). Attached when the project's OWNER
        // has it-ops enabled — the tools run in THIS process (creds never reach the
        // scrubbed agent env). See itops-mcp.ts + user-itops.ts.
        // `appdiag` (always on): lets the agent read the running preview's console
        // + Nuxt backend errors to self-diagnose. `itops` (opt-in): infra broker.
        mcpServers: {
          appdiag: buildDiagnosticsMcpServer(projectId),
          ...(itopsEnabled ? { itops: buildItopsMcpServer() } : {}),
          ...(imagesOn ? { images: buildImagesMcpServer(projectId, absoluteProjectPath) } : {}),
          // Org-shared external MCP servers (company tier), then project-defined
          // ones (which win on name collision). Reserved names are blocked at
          // create time, so neither ever shadows the brokered tools.
          ...sharedMcpServers,
          ...projectMcpServers,
        },
        // See skillSettingSources above: ['project','user'] by default (auto-load
        // all skills), or ['project'] once any skill is disabled (load only the
        // staged enabled set, making per-project disabling a hard guarantee).
        settingSources: skillSettingSources,
        model: resolvedModel,
        resume: sessionId, // Resume previous session
        permissionMode: 'bypassPermissions', // Auto-approve commands and edits
        // Extended thinking: off / adaptive (auto) / adaptive+high (forced).
        // Thinking blocks the model emits are surfaced to the chat below.
        ...buildThinkingOptions(options.thinkingMode),
        systemPrompt: systemPromptForStack,
        maxOutputTokens,
        // Capture SDK stderr so we can surface real errors instead of just exit code
        stderr: (data: string) => {
          const line = String(data).trimEnd();
          if (!line) return;
          // Keep only the last ~200 lines to avoid memory bloat
          if (stderrBuffer.length > 200) stderrBuffer.shift();
          stderrBuffer.push(line);
          // Also mirror to server logs for live debugging
          console.error(`[ClaudeSDK][stderr] ${line}`);
        },
      } as any,
    });

    // Handle streaming response
    for await (const message of response) {
      console.log('[ClaudeService] Message type:', message.type);

      if (message.type === 'stream_event') {
        const event: any = (message as any).event ?? {};
        const sessionKey = (message.session_id ?? message.uuid ?? 'default').toString();
        console.log('[ClaudeService] Stream event type:', event.type);

        let streamState = assistantStreamStates.get(sessionKey);

        switch (event.type) {
          case 'message_start': {
            const newState: AssistantStreamState = {
              messageId: randomUUID(),
              content: '',
              hasSentUpdate: false,
              finalized: false,
            };
            assistantStreamStates.set(sessionKey, newState);
            break;
          }
          case 'content_block_start': {
            const contentBlock = event.content_block;
            if (contentBlock && typeof contentBlock === 'object' && contentBlock.type === 'tool_use') {
              const metadata = buildToolMetadata(contentBlock as Record<string, unknown>);
              await dispatchToolMessage({
                projectId,
                metadata,
                content: `Using tool: ${contentBlock.name ?? 'tool'}`,
                requestId,
                persist: false,
                isStreaming: true,
              });
            }
            break;
          }
          case 'content_block_delta': {
            const delta = event.delta;
            let textChunk = '';

            if (typeof delta === 'string') {
              textChunk = delta;
            } else if (delta && typeof delta === 'object') {
              if (typeof delta.text === 'string') {
                textChunk = delta.text;
              } else if (typeof delta.delta === 'string') {
                textChunk = delta.delta;
              } else if (typeof delta.partial === 'string') {
                textChunk = delta.partial;
              }
            }

            if (typeof textChunk !== 'string' || textChunk.length === 0) {
              break;
            }

            if (!streamState || streamState.finalized) {
              streamState = {
                messageId: randomUUID(),
                content: '',
                hasSentUpdate: false,
                finalized: false,
              };
              assistantStreamStates.set(sessionKey, streamState);
            }

            streamState.content += textChunk;
            const trimmedContent = streamState.content.trim();
            const isPlaceholderLine =
              trimmedContent.length > 0 &&
              ((/^\[Tool:\s*.+\]$/i.test(trimmedContent) && !trimmedContent.includes('\n')) ||
                /^Using tool:/i.test(trimmedContent) ||
                /^Tool result:/i.test(trimmedContent));

            if (trimmedContent.length === 0) {
              streamState.content = '';
              streamState.hasSentUpdate = false;
              break;
            }

            if (isPlaceholderLine) {
              const shouldHandle = markPlaceholderHandled(sessionKey, trimmedContent);
              if (shouldHandle) {
                try {
                  await handleToolPlaceholderMessage(
                    projectId,
                    trimmedContent,
                    requestId,
                    undefined,
                    { dedupeStore: persistedToolMessageSignatures }
                  );
                } catch (error) {
                  console.error('[ClaudeService] Failed to handle streaming tool placeholder:', error);
                }
              }
              streamState.content = '';
              streamState.hasSentUpdate = false;
              break;
            }

            streamState.hasSentUpdate = true;

            streamManager.publish(projectId, {
              type: 'message',
              data: createRealtimeMessage({
                id: streamState.messageId,
                projectId,
                role: 'assistant',
                content: streamState.content,
                messageType: 'chat',
                requestId,
                isStreaming: true,
              }),
            });
            break;
          }
          case 'message_stop': {
            if (streamState && streamState.hasSentUpdate && !streamState.finalized) {
              const trimmedContent = streamState.content.trim();
              const isPlaceholderLine =
                trimmedContent.length > 0 &&
                ((/^\[Tool:\s*.+\]$/i.test(trimmedContent) && !trimmedContent.includes('\n')) ||
                  /^Using tool:/i.test(trimmedContent) ||
                  /^Tool result:/i.test(trimmedContent));

              if (isPlaceholderLine) {
                const shouldHandle = markPlaceholderHandled(sessionKey, trimmedContent);
                if (shouldHandle) {
                  try {
                    await handleToolPlaceholderMessage(
                      projectId,
                      trimmedContent,
                      requestId,
                      undefined,
                      { dedupeStore: persistedToolMessageSignatures }
                    );
                  } catch (error) {
                    console.error('[ClaudeService] Failed to handle tool placeholder on stop:', error);
                  }
                }
              }

              if (
                trimmedContent.length === 0 ||
                isPlaceholderLine
              ) {
                streamState.hasSentUpdate = false;
              }

              if (!streamState.hasSentUpdate) {
                streamState.content = '';
                assistantStreamStates.delete(sessionKey);
                break;
              }

              streamState.finalized = true;

              const savedMessage = await createMessage({
                id: streamState.messageId,
                projectId,
                role: 'assistant',
                messageType: 'chat',
                content: streamState.content,
                cliSource: 'claude',
                // Stamp the turn's requestId so checkpointTurn can locate this
                // assistant message to attach the commit sha ("Revert to here").
                ...(requestId ? { requestId } : {}),
              });

              streamManager.publish(projectId, {
                type: 'message',
                data: serializeMessage(savedMessage, {
                  isStreaming: false,
                  isFinal: true,
                  requestId,
                }),
              });

              completedStreamSessions.add(sessionKey);
            }

            assistantStreamStates.delete(sessionKey);
            break;
          }
          default:
            break;
        }

        continue;
      }

      // Whole-message handling (system/init, assistant, result) is shared with
      // the containerized path — see agent-messages.ts.
      const kind = await processor.processMessage(message as Parameters<typeof processor.processMessage>[0]);
      if (kind === 'result') {
        emittedCompletedStatus = true;
      }
    }

    console.log('[ClaudeService] Streaming completed');
    await safeMarkCompleted();
    if (!emittedCompletedStatus) {
      publishStatus('completed');
      emittedCompletedStatus = true;
    }
  } catch (error) {
    // User-initiated Stop: not an error. Close the turn quietly (CLI parity:
    // the transcript keeps whatever streamed before the interrupt).
    if (abortController.signal.aborted) {
      console.log('[ClaudeService] Turn stopped by user');
      // Flush any partial assistant text that message_stop never persisted, so
      // what the user already saw survives a reload (CLI parity).
      for (const state of assistantStreamStates.values()) {
        if (state.finalized) continue;
        if (!state.content.trim()) continue;
        try {
          const saved = await createMessage({
            id: state.messageId,
            projectId,
            role: 'assistant',
            messageType: 'chat',
            content: state.content,
            cliSource: 'claude',
            ...(requestId ? { requestId } : {}),
          });
          streamManager.publish(projectId, {
            type: 'message',
            data: serializeMessage(saved, { isStreaming: false, isFinal: true, requestId }),
          });
        } catch (persistError) {
          console.error('[ClaudeService] Failed to persist partial text on stop:', persistError);
        }
      }
      await persistInterruptedMarker(projectId, requestId);
      await safeMarkFailed('Stopped by user');
      if (!emittedCompletedStatus) {
        publishStatus('completed', 'Stopped by user');
        emittedCompletedStatus = true;
      }
      return;
    }

    console.error(`[ClaudeService] Failed to execute Claude:`, error);

    let errorMessage = 'Unknown error';

    if (error instanceof Error) {
      errorMessage = error.message;

      // Detect Claude Code CLI not installed
      if (errorMessage.includes('command not found') || errorMessage.includes('not found: claude')) {
        errorMessage = `Claude Code CLI is not installed.\n\nInstallation instructions:\n1. npm install -g @anthropic-ai/claude-code\n2. claude auth login`;
      }
      // Detect authentication failure
      else if (errorMessage.includes('not authenticated') || errorMessage.includes('authentication')) {
        errorMessage = `Claude Code CLI authentication required.\n\nAuthentication method:\nclaude auth login`;
      }
      // Permission error
      else if (errorMessage.includes('permission') || errorMessage.includes('EACCES')) {
        errorMessage = `No file access permission. Please check project directory permissions.`;
      }
      // Token limit exceeded
      else if (errorMessage.includes('max_tokens')) {
        errorMessage = `Generation length is too long. Please shorten the prompt or split the request into smaller parts.`;
      }
      // Generic process exit without details – attempt to surface last stderr lines
      else if (/process exited with code \d+/.test(errorMessage) && stderrBuffer.length > 0) {
        // Heuristics: extract likely actionable hints from stderr
        const tail = stderrBuffer.slice(-15).join('\n');
        // Common auth hints
        if (/auth\s+login|not\s+logged\s+in|sign\s+in/i.test(tail)) {
          errorMessage = `Claude Code CLI authentication required.\n\nAuthentication method:\nclaude auth login\n\nDetailed log:\n${tail}`;
        } else if (/network|ENOTFOUND|ECONN|timeout/i.test(tail)) {
          errorMessage = `Failed to run Claude Code due to network error. Please check your network connection and try again.\n\nDetailed log:\n${tail}`;
        } else if (/permission|EACCES|EPERM|denied/i.test(tail)) {
          errorMessage = `Execution interrupted due to file access permission error. Please check project directory permissions.\n\nDetailed log:\n${tail}`;
        } else if (/model|unsupported|invalid\s+model/i.test(tail)) {
          errorMessage = `There is a problem with the model settings. Please try changing the model.\n\nDetailed log:\n${tail}`;
        } else {
          errorMessage = `${errorMessage}\n\nDetailed log:\n${tail}`;
        }
      }
    }

    // When this attempt will be retried (e.g. a failed session resume), stay
    // silent so the user doesn't see a spurious error — just rethrow.
    if (options.suppressUserError) {
      throw new Error(errorMessage);
    }

    await safeMarkFailed(errorMessage);
    publishStatus('error', errorMessage);

    // Persist + stream a visible error message so it shows up in the chat log.
    try {
      const errorChatMessage = await createMessage({
        projectId,
        role: 'assistant',
        messageType: 'error',
        content: errorMessage,
        cliSource: 'claude',
      });
      streamManager.publish(projectId, {
        type: 'message',
        data: serializeMessage(errorChatMessage, requestId ? { requestId } : undefined),
      });
    } catch (persistError) {
      console.error('[ClaudeService] Failed to persist error message:', persistError);
    }

    // Also send the error status via SSE
    streamManager.publish(projectId, {
      type: 'error',
      error: errorMessage,
      data: requestId ? { requestId } : undefined,
    });

    throw new Error(errorMessage);
  } finally {
    unregisterAgentRun(projectId, requestId);
  }
}

/**
 * Initialize Next.js project with Claude Code
 *
 * @param projectId - Project ID
 * @param projectPath - Project directory path
 * @param initialPrompt - Initial prompt
 * @param model - Claude model to use (default: claude-sonnet-4-6)
 * @param requestId - (Optional) User request tracking ID
 */
export async function initializeNextJsProject(
  projectId: string,
  projectPath: string,
  initialPrompt: string,
  model: string = CLAUDE_DEFAULT_MODEL,
  requestId?: string,
  requesterItopsEnabled?: boolean,
  requesterUserId?: string
): Promise<void> {
  console.log(`[ClaudeService] Initializing Nuxt project: ${projectId}`);

  // Nuxt project creation command
  const fullPrompt = `
Build a Nuxt 4 application with the following requirements:
${initialPrompt}

Use Nuxt 4 (Vue 3 <script setup lang="ts">, file-based routing in pages/) and Nuxt UI (@nuxt/ui) components — consult the "nuxt-ui" skill. The app is wrapped in <UApp>. Use TypeScript and Tailwind utility classes.
Build on the existing scaffold in the project root and implement the requested features.
`.trim();

  await executeClaude(projectId, projectPath, fullPrompt, model, undefined, requestId, { requesterItopsEnabled, requesterUserId });
}

/**
 * Apply changes to project
 *
 * @param projectId - Project ID
 * @param projectPath - Project directory path
 * @param instruction - Change request command
 * @param model - Claude model to use (default: claude-sonnet-4-6)
 * @param sessionId - Session ID
 * @param requestId - (Optional) User request tracking ID
 */
export async function applyChanges(
  projectId: string,
  projectPath: string,
  instruction: string,
  model: string = CLAUDE_DEFAULT_MODEL,
  sessionId?: string,
  requestId?: string,
  thinkingMode?: ThinkingMode,
  requesterItopsEnabled?: boolean,
  requesterUserId?: string
): Promise<void> {
  console.log(`[ClaudeService] Applying changes to project: ${projectId}`);
  try {
    // On a resume, suppress user-facing errors for this attempt so a failed
    // resume can be retried silently (the retry surfaces errors normally).
    await executeClaude(projectId, projectPath, instruction, model, sessionId, requestId, {
      suppressUserError: Boolean(sessionId),
      thinkingMode,
      requesterItopsEnabled,
      requesterUserId,
    });
  } catch (error) {
    // Resuming a corrupt/incompatible session can fail immediately (exit code 1 /
    // error_during_execution). Recover by retrying once with a fresh session.
    if (sessionId) {
      console.warn('[ClaudeService] Resume failed; retrying with a fresh session:', error instanceof Error ? error.message : error);
      await executeClaude(projectId, projectPath, instruction, model, undefined, requestId, {
        thinkingMode,
        requesterItopsEnabled,
        requesterUserId,
      });
    } else {
      throw error;
    }
  }
}
