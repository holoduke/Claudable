/**
 * Claude Agent SDK Service - Claude Agent SDK Integration
 *
 * Interacts with projects using the Claude Agent SDK.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSession, ClaudeResponse } from '@/types/backend';
import { streamManager } from '../stream';
import { serializeMessage, createRealtimeMessage } from '@/lib/serializers/chat';
import { updateProject, getProjectById } from '../project';
import { syncProjectSkills, hasDisabledSkills } from '../skills';
import { CLAUDE_SYSTEM_PROMPT } from './prompts/claude-system-prompt';
import { NEXT_SYSTEM_PROMPT } from './prompts/next-system-prompt';
import { ANGULAR_SYSTEM_PROMPT } from './prompts/angular-system-prompt';
import { STATIC_SYSTEM_PROMPT } from './prompts/static-system-prompt';
import { stackKind } from '@/lib/config/stacks';
import { resolveProjectClaudeToken } from '../claude-credentials';
import { buildItopsMcpServer } from '../itops/itops-mcp';
import { buildDiagnosticsMcpServer } from '../diagnostics-mcp';
import { getProjectService } from '../project-services';
import { createMessage } from '../message';
import { CLAUDE_DEFAULT_MODEL, normalizeClaudeModelId, getClaudeModelDisplayName } from '@/lib/constants/claudeModels';
import path from 'path';
import os from 'os';

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

/** The system prompt for a project's tech stack (Nuxt | Next.js | Angular). */
function selectSystemPrompt(templateType: string | null | undefined): string {
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

  const pathAllowed = (p: string): boolean => {
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(projectAbsPath, p);
    return pathIsInside(abs, projectAbsPath) || pathIsInside(abs, tmpDir);
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

import { type ToolAction, pickFirstString, buildToolMetadata, inferActionFromToolName } from './tool-metadata';

interface ToolPlaceholderDetails {
  raw: string;
  toolName?: string;
  target?: string;
  summary?: string;
  action?: ToolAction;
  isResult: boolean;
}

const parseToolPlaceholderText = (text: string): ToolPlaceholderDetails | null => {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  let toolName: string | undefined;
  let target: string | undefined;
  let summary: string | undefined;
  let isResult = false;

  const bracketMatch = trimmed.match(/^\[Tool:\s*([^\]\n]+)\s*\](.*)$/i);
  if (bracketMatch) {
    toolName = bracketMatch[1]?.trim();
    const trailing = bracketMatch[2]?.trim();
    if (trailing) {
      target = trailing;
    }
  }

  const usingToolMatch = trimmed.match(/^Using tool:\s*([^\n]+?)(?:\s+on\s+(.+))?$/i);
  if (usingToolMatch) {
    toolName = toolName ?? usingToolMatch[1]?.trim();
    const maybeTarget = usingToolMatch[2]?.trim();
    if (maybeTarget) {
      target = maybeTarget;
    }
  }

  const toolResultMatch = trimmed.match(/^Tool result:\s*(.+)$/i);
  if (toolResultMatch) {
    summary = toolResultMatch[1]?.trim() || undefined;
    isResult = true;
  }

  if (!toolName && !target && !summary) {
    return null;
  }

  const action = inferActionFromToolName(toolName) ?? (isResult ? undefined : 'Executed');

  return {
    raw: trimmed,
    toolName,
    target,
    summary,
    action,
    isResult,
  };
};

const buildMetadataFromPlaceholder = (details: ToolPlaceholderDetails): Record<string, unknown> => {
  const metadata: Record<string, unknown> = {};

  if (details.toolName) {
    metadata.toolName = details.toolName;
    metadata.tool_name = details.toolName;
  }

  if (details.target) {
    metadata.filePath = details.target;
    metadata.file_path = details.target;
  }

  if (details.summary) {
    metadata.summary = details.summary;
  }

  const action = details.action ?? inferActionFromToolName(details.toolName);
  if (action) {
    metadata.action = action;
  }

  metadata.placeholderType = details.isResult ? 'result' : 'start';

  return metadata;
};

const mergeMetadata = (
  base: Record<string, unknown> | undefined,
  extension: Record<string, unknown>
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(extension)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
};

const normalizeSignatureValue = (value?: string | null): string => {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : '';
};

const computeToolMessageSignature = (
  metadata: Record<string, unknown>,
  content: string,
  messageType: 'tool_use' | 'tool_result' = 'tool_use'
): string => {
  const meta = metadata ?? {};
  const toolName =
    pickFirstString(meta.toolName) ?? pickFirstString(meta.tool_name);
  const filePath =
    pickFirstString(meta.filePath) ??
    pickFirstString(meta.file_path) ??
    pickFirstString(meta.targetPath) ??
    pickFirstString(meta.target_path);
  const summary =
    pickFirstString(meta.summary) ??
    pickFirstString(meta.resultSummary) ??
    pickFirstString(meta.result_summary) ??
    pickFirstString(meta.description);
  const command = pickFirstString(meta.command);
  const action = pickFirstString(meta.action);

  return [
    normalizeSignatureValue(messageType),
    normalizeSignatureValue(toolName),
    normalizeSignatureValue(filePath),
    normalizeSignatureValue(summary),
    normalizeSignatureValue(command),
    normalizeSignatureValue(action),
    normalizeSignatureValue(content),
  ].join('|');
};

const createToolMessageContent = (details: ToolPlaceholderDetails): string => {
  if (details.isResult && details.summary) {
    return `Tool result: ${details.summary}`;
  }
  if (details.toolName) {
    const targetSegment = details.target ? ` on ${details.target}` : '';
    return `Using tool: ${details.toolName}${targetSegment}`;
  }
  return details.raw;
};

const dispatchToolMessage = async ({
  projectId,
  metadata,
  content,
  requestId,
  persist = true,
  isStreaming = false,
  messageType = 'tool_use',
  dedupeKey,
  dedupeStore,
}: {
  projectId: string;
  metadata: Record<string, unknown>;
  content: string;
  requestId?: string;
  persist?: boolean;
  isStreaming?: boolean;
  messageType?: 'tool_use' | 'tool_result';
  dedupeKey?: string;
  dedupeStore?: Set<string>;
}): Promise<void> => {
  const trimmedContent = content.trim();
  if (!trimmedContent) {
    return;
  }

  const enrichedMetadata = {
    ...(metadata ?? {}),
  };

  if (requestId && !enrichedMetadata.requestId) {
    enrichedMetadata.requestId = requestId;
  }

  if (persist && dedupeStore && dedupeKey) {
    const normalizedKey = dedupeKey.trim();
    if (normalizedKey.length > 0) {
      if (dedupeStore.has(normalizedKey)) {
        return;
      }
      dedupeStore.add(normalizedKey);
    }
  }

  if (!persist) {
    const transientMetadata = {
      ...enrichedMetadata,
      isTransientToolMessage: true,
    };
    streamManager.publish(projectId, {
      type: 'message',
      data: createRealtimeMessage({
        projectId,
        role: 'tool',
        content: trimmedContent,
        messageType,
        metadata: transientMetadata,
        requestId,
        isStreaming,
      }),
    });
    return;
  }

  try {
    const savedMessage = await createMessage({
      projectId,
      role: 'tool',
      messageType,
      content: trimmedContent,
      metadata: enrichedMetadata,
      cliSource: 'claude',
    });

    streamManager.publish(projectId, {
      type: 'message',
      data: serializeMessage(savedMessage, {
        requestId,
        isStreaming,
        isFinal: !isStreaming,
      }),
    });
  } catch (error) {
    console.error('[ClaudeService] Failed to persist tool message:', error);
  }
};

const handleToolPlaceholderMessage = async (
  projectId: string,
  placeholderText: string,
  requestId: string | undefined,
  baseMetadata?: Record<string, unknown>,
  options?: { dedupeStore?: Set<string> }
): Promise<boolean> => {
  const details = parseToolPlaceholderText(placeholderText);
  if (!details) {
    return false;
  }

  const metadata = mergeMetadata(baseMetadata, buildMetadataFromPlaceholder(details));
  const content = createToolMessageContent(details);
  const messageType: 'tool_use' | 'tool_result' = details.isResult ? 'tool_result' : 'tool_use';
  const signature = computeToolMessageSignature(metadata, content, messageType);

  await dispatchToolMessage({
    projectId,
    metadata,
    content,
    requestId,
    persist: true,
    isStreaming: false,
    messageType,
    dedupeKey: signature,
    dedupeStore: options?.dedupeStore,
  });

  return true;
};

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

export async function executeClaude(
  projectId: string,
  projectPath: string,
  instruction: string,
  model: string = CLAUDE_DEFAULT_MODEL,
  sessionId?: string,
  requestId?: string,
  options: { suppressUserError?: boolean; thinkingMode?: ThinkingMode; requesterItopsEnabled?: boolean } = {}
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

  // Send start notification via SSE
  publishStatus('starting', 'Initializing Claude Agent SDK...');

  await safeMarkRunning();

  // Collect stderr from SDK process for better diagnostics
  const stderrBuffer: string[] = [];
  const placeholderHistory = new Map<string, Set<string>>();
  const persistedToolMessageSignatures = new Set<string>();
  const markPlaceholderHandled = (sessionKey: string, placeholder: string): boolean => {
    const normalized = placeholder.trim();
    if (!normalized) {
      return false;
    }
    let entries = placeholderHistory.get(sessionKey);
    if (!entries) {
      entries = new Set<string>();
      placeholderHistory.set(sessionKey, entries);
    }
    if (entries.has(normalized)) {
      return false;
    }
    entries.add(normalized);
    return true;
  };

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

    // Pick the system prompt for the project's tech stack (Nuxt | Next.js | Angular).
    const stackProject = await getProjectById(projectId).catch(() => null);
    let systemPromptForStack = selectSystemPrompt(stackProject?.templateType);

    // Tell the agent which model it's running as — otherwise it guesses its own
    // version wrong (e.g. answering "4.6" when the user selected Fable 5).
    systemPromptForStack += `\n\nYou are running as ${modelLabel} (model id \`${resolvedModel}\`). If asked which model you are, answer with this.`;

    // Tell the agent about the live diagnostics tool so it verifies its own work
    // and can act on real runtime errors instead of guessing.
    systemPromptForStack += `\n\n## Checking the running app\nYou have a tool \`mcp__appdiag__check_app_health\` that returns the CURRENTLY RUNNING preview's uncaught browser errors, console errors/warnings, and Nuxt backend (server) errors. Use it to:\n- verify a change actually works after you edit (check for new errors before saying you're done),\n- investigate when the user reports something is broken,\n- find real bugs to fix proactively.\nAn empty result means nothing has been reported since the preview last started — it is not proof the app is bug-free; exercise the feature in the preview, then check again.`;

    // If a Postgres was provisioned for this project, tell the agent so it builds
    // data-backed features against DATABASE_URL (set in the preview + deploy env).
    try {
      const dbSvc = await getProjectService(projectId, 'database');
      if ((dbSvc?.serviceData as { engine?: string } | undefined)?.engine === 'postgresql') {
        systemPromptForStack += `\n\n## Database\nThis project has a PostgreSQL database. Its connection string is in the DATABASE_URL environment variable (already set in the running preview). Use it for any data persistence — prefer Prisma (schema datasource \`url = env("DATABASE_URL")\`, run \`prisma db push\`) or Drizzle/pg. Never hardcode credentials; always read DATABASE_URL from the environment.`;
      }
    } catch { /* non-fatal */ }

    // it-ops follows the USER running the agent, NOT the project: attach the broker
    // only when the person who triggered this run has it-ops enabled. A different
    // user opening the same project gets no tools unless they too have it-ops.
    const itopsEnabled = options.requesterItopsEnabled === true;

    // Resolve the Claude credential for this project (a user's connected token),
    // falling back to the global env token. Built here so it overrides the scrubbed
    // CLAUDE_CODE_OAUTH_TOKEN in the agent env below.
    const agentEnv = buildAgentEnv();
    try {
      const projectToken = await resolveProjectClaudeToken(projectId);
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
    const response = query({
      prompt: instruction,
      options: {
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

    let currentSessionId: string | undefined = sessionId;

    interface AssistantStreamState {
      messageId: string;
      content: string;
      hasSentUpdate: boolean;
      finalized: boolean;
    }

    const assistantStreamStates = new Map<string, AssistantStreamState>();
    const completedStreamSessions = new Set<string>();

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

      // Handle by message type
      if (message.type === 'system' && message.subtype === 'init') {
        // Initialize session
        currentSessionId = message.session_id;
        console.log(`[ClaudeService] Session initialized: ${currentSessionId}`);

        // Save session ID to project
        if (currentSessionId) {
          await updateProject(projectId, {
            activeClaudeSessionId: currentSessionId,
          });
        }

        // Send connection notification via SSE
        streamManager.publish(projectId, {
          type: 'connected',
          data: {
            projectId,
            sessionId: currentSessionId,
            timestamp: new Date().toISOString(),
            connectionStage: 'assistant',
          },
        });
      } else if (message.type === 'assistant') {
        const sessionKey = (message.session_id ?? message.uuid ?? 'default').toString();
        if (completedStreamSessions.has(sessionKey)) {
          completedStreamSessions.delete(sessionKey);
          continue;
        }

        // Assistant message
        const assistantMessage = message.message;
        let content = '';

        // Extract content
        if (typeof assistantMessage.content === 'string') {
          content = assistantMessage.content;
        } else if (Array.isArray(assistantMessage.content)) {
          const parts: string[] = [];
          for (const block of assistantMessage.content as unknown[]) {
            if (!block || typeof block !== 'object') {
              continue;
            }

            const safeBlock = block as any;

            // Surface extended-thinking blocks so the user can see the model's
            // reasoning. ChatLog renders <thinking>…</thinking> as a collapsible
            // section, so wrap the reasoning text in those tags.
            if (safeBlock.type === 'thinking') {
              const thinkingText =
                typeof safeBlock.thinking === 'string'
                  ? safeBlock.thinking.trim()
                  : '';
              if (thinkingText) {
                parts.push(`<thinking>${thinkingText}</thinking>`);
              }
              continue;
            }

            if (safeBlock.type === 'text') {
              const text = typeof safeBlock.text === 'string' ? safeBlock.text : '';
              const trimmed = text.trim();
              if (!trimmed) {
                continue;
              }

              const isPlaceholderLine =
                /^\[Tool:\s*/i.test(trimmed) ||
                /^Using tool:/i.test(trimmed) ||
                /^Tool result:/i.test(trimmed);

              if (isPlaceholderLine) {
                const shouldHandle = markPlaceholderHandled(sessionKey, trimmed);
                if (shouldHandle) {
                  try {
                    await handleToolPlaceholderMessage(
                      projectId,
                      trimmed,
                      requestId,
                      undefined,
                      { dedupeStore: persistedToolMessageSignatures }
                    );
                  } catch (error) {
                    console.error('[ClaudeService] Failed to handle assistant tool placeholder:', error);
                  }
                }
                continue;
              }

              parts.push(text);
              continue;
            }

            if (safeBlock.type === 'tool_use') {
              const metadata = buildToolMetadata(safeBlock as Record<string, unknown>);
              const name = typeof safeBlock.name === 'string' ? safeBlock.name : pickFirstString(safeBlock.name);
              const toolContent = `Using tool: ${name ?? 'tool'}`;
              await dispatchToolMessage({
                projectId,
                metadata,
                content: toolContent,
                requestId,
                persist: true,
                isStreaming: false,
                messageType: 'tool_use',
                dedupeKey: computeToolMessageSignature(metadata, toolContent, 'tool_use'),
                dedupeStore: persistedToolMessageSignatures,
              });
              continue;
            }
          }

          content = parts.join('\n');
        }

        console.log('[ClaudeService] Assistant message:', content.substring(0, 100));

        // Save message to DB
        if (content) {
          const savedMessage = await createMessage({
            projectId,
            role: 'assistant',
            messageType: 'chat',
            content,
            // sessionId is Session table foreign key, so don't store Claude SDK session ID
            // Claude SDK session ID is stored in project.activeClaudeSessionId
            cliSource: 'claude',
          });

          // Send via SSE in real-time
          streamManager.publish(projectId, {
            type: 'message',
            data: serializeMessage(savedMessage, { requestId }),
          });
        }
      } else if (message.type === 'result') {
        // Final result
        console.log('[ClaudeService] Task completed:', message.subtype);

        publishStatus('completed');
        emittedCompletedStatus = true;
        await safeMarkCompleted();
      }
    }

    console.log('[ClaudeService] Streaming completed');
    await safeMarkCompleted();
    if (!emittedCompletedStatus) {
      publishStatus('completed');
      emittedCompletedStatus = true;
    }
  } catch (error) {
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
  requesterItopsEnabled?: boolean
): Promise<void> {
  console.log(`[ClaudeService] Initializing Nuxt project: ${projectId}`);

  // Nuxt project creation command
  const fullPrompt = `
Build a Nuxt 4 application with the following requirements:
${initialPrompt}

Use Nuxt 4 (Vue 3 <script setup lang="ts">, file-based routing in pages/) and Nuxt UI (@nuxt/ui) components — consult the "nuxt-ui" skill. The app is wrapped in <UApp>. Use TypeScript and Tailwind utility classes.
Build on the existing scaffold in the project root and implement the requested features.
`.trim();

  await executeClaude(projectId, projectPath, fullPrompt, model, undefined, requestId, { requesterItopsEnabled });
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
  requesterItopsEnabled?: boolean
): Promise<void> {
  console.log(`[ClaudeService] Applying changes to project: ${projectId}`);
  try {
    // On a resume, suppress user-facing errors for this attempt so a failed
    // resume can be retried silently (the retry surfaces errors normally).
    await executeClaude(projectId, projectPath, instruction, model, sessionId, requestId, {
      suppressUserError: Boolean(sessionId),
      thinkingMode,
      requesterItopsEnabled,
    });
  } catch (error) {
    // Resuming a corrupt/incompatible session can fail immediately (exit code 1 /
    // error_during_execution). Recover by retrying once with a fresh session.
    if (sessionId) {
      console.warn('[ClaudeService] Resume failed; retrying with a fresh session:', error instanceof Error ? error.message : error);
      await executeClaude(projectId, projectPath, instruction, model, undefined, requestId, {
        thinkingMode,
        requesterItopsEnabled,
      });
    } else {
      throw error;
    }
  }
}
