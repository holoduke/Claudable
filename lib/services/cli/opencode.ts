import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message } from '@/types/backend';
import type { RealtimeMessage } from '@/types';
import { getProjectById, updateProject } from '@/lib/services/project';
import { streamManager } from '@/lib/services/stream';
import { createMessage } from '@/lib/services/message';
import { serializeMessage, createRealtimeMessage } from '@/lib/serializers/chat';
import { getDefaultModelForCli } from '@/lib/constants/cliModels';
import {
  OPENCODE_DEFAULT_MODEL,
  getOpenCodeModelDisplayName,
  normalizeOpenCodeModelId,
} from '@/lib/constants/opencodeModels';
import {
  markUserRequestAsCompleted,
  markUserRequestAsFailed,
  markUserRequestAsRunning,
} from '@/lib/services/user-requests';

const AUTO_INSTRUCTIONS = `Act autonomously without waiting for confirmations.
Use OpenCode tools to inspect, edit, run, and test files directly in the current workspace.
Avoid creating new top-level directories unless the user explicitly asks for it.
Keep output concise and include implementation details only when relevant.`;

const STATUS_LABELS: Record<string, string> = {
  starting: 'Initializing OpenCode CLI...',
  ready: 'OpenCode CLI ready',
  running: 'OpenCode is processing your request...',
  completed: 'OpenCode execution completed',
};

const OPENCODE_EXECUTABLE = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';

export interface OpenCodeParsedEvent {
  type: 'assistant' | 'event';
  text?: string;
  raw: Record<string, unknown>;
}

function publishStatus(projectId: string, status: string, requestId?: string, message?: string) {
  streamManager.publish(projectId, {
    type: 'status',
    data: {
      status,
      message: message ?? STATUS_LABELS[status] ?? '',
      ...(requestId ? { requestId } : {}),
    },
  });
}

async function ensureProjectPath(projectId: string, projectPath: string): Promise<string> {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const absolute = path.isAbsolute(projectPath)
    ? path.resolve(projectPath)
    : path.resolve(process.cwd(), projectPath);
  const allowedBasePath = path.resolve(process.cwd(), process.env.PROJECTS_DIR || './data/projects');
  const relativeToBase = path.relative(allowedBasePath, absolute);
  const isWithinBase = !relativeToBase.startsWith('..') && !path.isAbsolute(relativeToBase);
  if (!isWithinBase) {
    throw new Error('Project path must be within the configured projects directory');
  }

  try {
    await fs.access(absolute);
  } catch {
    await fs.mkdir(absolute, { recursive: true });
  }

  return absolute;
}

async function resolveRepoPath(projectPath: string): Promise<string> {
  const candidate = path.join(projectPath, 'repo');
  try {
    const stats = await fs.stat(candidate);
    if (stats.isDirectory()) {
      return candidate;
    }
  } catch {
    // ignore missing repo folder
  }
  return projectPath;
}

async function appendProjectContext(baseInstruction: string, repoPath: string): Promise<string> {
  try {
    const entries = await fs.readdir(repoPath, { withFileTypes: true });
    const visible = entries
      .filter((entry) => !entry.name.startsWith('.git') && entry.name !== 'AGENTS.md')
      .map((entry) => entry.name);

    if (visible.length === 0) {
      return `${baseInstruction}

<current_project_context>
This is an empty project directory. Work directly in the current folder without creating extra subdirectories.
</current_project_context>`;
    }

    return `${baseInstruction}

<current_project_context>
Current files in project directory: ${visible.sort().join(', ')}
Work directly in the current directory. Do not create subdirectories unless specifically requested.
</current_project_context>`;
  } catch (error) {
    console.warn('[OpenCodeService] Failed to append project context:', error);
    return baseInstruction;
  }
}

function buildOpenCodeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const additionalPaths: string[] = [];
  const npmGlobal = process.env.NPM_GLOBAL_PATH;
  if (npmGlobal) {
    additionalPaths.push(npmGlobal);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    const localApp = process.env.LOCALAPPDATA;
    if (appData) {
      additionalPaths.push(path.join(appData, 'npm'));
    }
    if (localApp) {
      additionalPaths.push(path.join(localApp, 'Programs', 'nodejs'));
    }
  }
  if (additionalPaths.length > 0) {
    const existingPath = env.PATH || env.Path || '';
    env.PATH = [...additionalPaths, existingPath].filter(Boolean).join(path.delimiter);
  }

  env.NO_COLOR = '1';
  env.CI = env.CI ?? '1';
  env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  env.OPENCODE_DISABLE_TERMINAL_TITLE = 'true';
  return env;
}

export function buildOpenCodeRunArgs(prompt: string, model: string, sessionId?: string | null): string[] {
  const args = [
    'run',
    '--format',
    'json',
    '--model',
    normalizeOpenCodeModelId(model),
  ];
  if (sessionId) {
    args.push('--session', sessionId);
  }
  args.push(prompt);
  return args;
}

function pickText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = ['content', 'text', 'delta', 'message', 'output', 'result'];
  for (const key of keys) {
    const candidate = pickText(record[key]);
    if (candidate) {
      return candidate;
    }
  }
  for (const key of ['part', 'data', 'event']) {
    const candidate = pickText(record[key]);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

export function parseOpenCodeJsonLine(line: string): OpenCodeParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    const text = pickText(raw);
    if (text) {
      return { type: 'assistant', text, raw };
    }
    return { type: 'event', raw };
  } catch {
    return null;
  }
}

function pickSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['sessionId', 'sessionID', 'session_id']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  for (const nested of Object.values(record)) {
    const candidate = pickSessionId(nested);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

export function getActiveOpenCodeSessionId(settings?: string | null): string | undefined {
  if (!settings) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(settings) as Record<string, unknown>;
    const candidate = parsed.activeOpenCodeSessionId;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function mergeActiveOpenCodeSessionId(settings: string | null | undefined, sessionId: string): string {
  let parsed: Record<string, unknown> = {};
  if (settings) {
    try {
      const candidate = JSON.parse(settings) as Record<string, unknown>;
      if (candidate && typeof candidate === 'object') {
        parsed = candidate;
      }
    } catch {
      parsed = {};
    }
  }
  return JSON.stringify({
    ...parsed,
    activeOpenCodeSessionId: sessionId,
  });
}

async function persistAssistantMessage(
  projectId: string,
  payload: {
    role: Message['role'];
    messageType: Message['messageType'];
    content: string;
    metadata?: Record<string, unknown> | null;
  },
  requestId?: string,
  realtimeOverrides?: Partial<RealtimeMessage>,
) {
  try {
    const saved = await createMessage({
      projectId,
      role: payload.role,
      messageType: payload.messageType,
      content: payload.content,
      metadata: payload.metadata ?? null,
      cliSource: 'opencode',
      requestId,
    });

    streamManager.publish(projectId, {
      type: 'message',
      data: serializeMessage(saved, {
        ...(requestId ? { requestId } : {}),
        ...(realtimeOverrides ?? {}),
      }),
    });
  } catch (error) {
    console.error('[OpenCodeService] Failed to persist message, falling back to realtime broadcast:', error);
    const fallback = createRealtimeMessage({
      projectId,
      role: payload.role,
      messageType: payload.messageType,
      content: payload.content,
      metadata: payload.metadata ?? null,
      cliSource: 'opencode',
      requestId,
      ...(realtimeOverrides ?? {}),
    });
    streamManager.publish(projectId, { type: 'message', data: fallback });
  }
}

async function executeOpenCode(
  projectId: string,
  projectPath: string,
  instruction: string,
  model: string,
  sessionId?: string,
  requestId?: string,
): Promise<void> {
  const normalizedModel = normalizeOpenCodeModelId(model);
  const modelDisplayName = getOpenCodeModelDisplayName(normalizedModel);

  publishStatus(projectId, 'starting', requestId);
  if (requestId) {
    await markUserRequestAsRunning(requestId);
  }

  const absoluteProjectPath = await ensureProjectPath(projectId, projectPath);
  const repoPath = await resolveRepoPath(absoluteProjectPath);

  publishStatus(projectId, 'ready', requestId, `OpenCode CLI detected (${modelDisplayName}). Starting execution...`);

  const promptBase = `${AUTO_INSTRUCTIONS}\n\n${instruction}`.trim();
  const promptWithContext = await appendProjectContext(promptBase, repoPath);

  publishStatus(projectId, 'running', requestId);

  const streamingMessageId = requestId ? `opencode-stream-${requestId}` : `opencode-stream-${randomUUID()}`;
  const streamingCreatedAt = new Date().toISOString();
  const assistantChunks: string[] = [];
  const stdoutLines: string[] = [];
  const stderrBuffer: string[] = [];
  let lastStreamedContent = '';
  let nextSessionId = sessionId;

  const emitStreamingUpdate = (content: string, { isFinal }: { isFinal: boolean }) => {
    const realtime = createRealtimeMessage({
      id: streamingMessageId,
      projectId,
      role: 'assistant',
      messageType: 'chat',
      content,
      metadata: { cli_type: 'opencode' },
      cliSource: 'opencode',
      requestId,
      createdAt: streamingCreatedAt,
      isStreaming: !isFinal,
      isFinal,
      isOptimistic: true,
    });
    streamManager.publish(projectId, { type: 'message', data: realtime });
  };

  const child = spawn(OPENCODE_EXECUTABLE, buildOpenCodeRunArgs(promptWithContext, normalizedModel, sessionId), {
    cwd: repoPath,
    env: buildOpenCodeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const text = String(chunk).trim();
    if (text) {
      stderrBuffer.push(text);
      console.error('[OpenCodeService][stderr]', text);
    }
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    stdoutLines.push(line);
    const parsed = parseOpenCodeJsonLine(line);
    const parsedSessionId = parsed?.raw ? pickSessionId(parsed.raw) : undefined;
    if (parsedSessionId) {
      nextSessionId = parsedSessionId;
    }
    if (!parsed?.text) {
      return;
    }
    assistantChunks.push(parsed.text);
    const content = assistantChunks.join('\n').trim();
    if (content && content !== lastStreamedContent) {
      lastStreamedContent = content;
      emitStreamingUpdate(content, { isFinal: false });
    }
  });

  const exitCode: number | null = await new Promise((resolve) => {
    child.on('error', (error) => {
      console.error('[OpenCodeService] Failed to start OpenCode CLI:', error);
      stderrBuffer.push(error.message);
      resolve(-1);
    });
    child.on('close', (code) => {
      resolve(code === null ? -1 : code);
    });
  });

  const finalContent = assistantChunks.join('\n').trim();
  if (finalContent) {
    emitStreamingUpdate(finalContent, { isFinal: true });
  }

  if (exitCode === 0) {
    if (nextSessionId && nextSessionId !== sessionId) {
      const latestProject = await getProjectById(projectId);
      await updateProject(projectId, {
        settings: mergeActiveOpenCodeSessionId(latestProject?.settings, nextSessionId),
      });
    }

    await persistAssistantMessage(
      projectId,
      {
        role: 'assistant',
        messageType: 'chat',
        content: finalContent || 'OpenCode execution completed.',
        metadata: { cli_type: 'opencode' },
      },
      requestId,
      { id: streamingMessageId, isStreaming: false, isFinal: true, isOptimistic: false },
    );

    publishStatus(projectId, 'completed', requestId, 'OpenCode execution completed successfully');
    if (requestId) {
      await markUserRequestAsCompleted(requestId);
    }
    return;
  }

  const stderrText = stderrBuffer.join('\n').trim();
  const errorMessage =
    stderrText ||
    (exitCode === -1
      ? 'OpenCode CLI is not installed or could not be launched. Install it and run opencode auth login if needed.'
      : `OpenCode CLI exited with status ${exitCode}`);
  const fallbackOutput = stdoutLines
    .map((line) => parseOpenCodeJsonLine(line)?.text)
    .filter((line): line is string => Boolean(line))
    .join('\n')
    .trim();

  publishStatus(projectId, 'completed', requestId, 'OpenCode execution ended with errors');
  if (requestId) {
    await markUserRequestAsFailed(requestId, errorMessage);
  }

  await persistAssistantMessage(
    projectId,
    {
      role: 'assistant',
      messageType: 'chat',
      content: fallbackOutput
        ? `${fallbackOutput}\n\nOpenCode CLI reported an error:\n${errorMessage}`
        : `OpenCode CLI reported an error:\n${errorMessage}`,
      metadata: {
        cli_type: 'opencode',
        error: true,
      },
    },
    requestId,
    { id: streamingMessageId, isStreaming: false, isFinal: true, isOptimistic: false },
  );
}

export async function initializeNextJsProject(
  projectId: string,
  projectPath: string,
  initialPrompt: string,
  model: string = OPENCODE_DEFAULT_MODEL,
  requestId?: string,
): Promise<void> {
  const fullPrompt = `
Create a new Next.js 15 application with the following requirements:
${initialPrompt}

Use App Router, TypeScript, and Tailwind CSS.
Set up the basic project structure and implement the requested features.`.trim();

  await executeOpenCode(
    projectId,
    projectPath,
    fullPrompt,
    model ?? getDefaultModelForCli('opencode'),
    undefined,
    requestId,
  );
}

export async function applyChanges(
  projectId: string,
  projectPath: string,
  instruction: string,
  model: string = OPENCODE_DEFAULT_MODEL,
  sessionId?: string,
  requestId?: string,
): Promise<void> {
  await executeOpenCode(
    projectId,
    projectPath,
    instruction,
    model ?? getDefaultModelForCli('opencode'),
    sessionId,
    requestId,
  );
}
