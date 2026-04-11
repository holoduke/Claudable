import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message } from '@/types/backend';
import type { RealtimeMessage } from '@/types';
import { getProjectById } from '@/lib/services/project';
import { streamManager } from '@/lib/services/stream';
import { createMessage } from '@/lib/services/message';
import { serializeMessage, createRealtimeMessage } from '@/lib/serializers/chat';
import { getDefaultModelForCli } from '@/lib/constants/cliModels';
import {
  DROID_DEFAULT_MODEL,
  getDroidModelDisplayName,
  normalizeDroidModelId,
} from '@/lib/constants/droidModels';
import { loadGlobalSettings } from '@/lib/services/settings';
import {
  markUserRequestAsCompleted,
  markUserRequestAsFailed,
  markUserRequestAsRunning,
} from '@/lib/services/user-requests';

const AUTO_INSTRUCTIONS = `Act autonomously without waiting for confirmations.
Use Factory Droid tools to inspect, edit, run, and test files directly in the current workspace.
Use medium autonomy for local development tasks.
Do not create new top-level directories unless the user explicitly asks for it.
Keep output concise and include implementation details only when relevant.`;

const STATUS_LABELS: Record<string, string> = {
  starting: 'Initializing Factory Droid CLI...',
  ready: 'Factory Droid CLI ready',
  running: 'Factory Droid is processing your request...',
  completed: 'Factory Droid execution completed',
};

const DROID_EXECUTABLE = process.platform === 'win32' ? 'droid.cmd' : 'droid';

export interface DroidParsedEvent {
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
    console.warn('[DroidService] Failed to append project context:', error);
    return baseInstruction;
  }
}

export function buildDroidEnv(apiKey?: string | null): NodeJS.ProcessEnv {
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

  const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (normalizedApiKey) {
    env.FACTORY_API_KEY = normalizedApiKey;
  }
  env.NO_COLOR = '1';
  env.CI = env.CI ?? '1';
  return env;
}

export function buildDroidExecArgs(
  prompt: string,
  model: string,
  repoPath: string,
  sessionId?: string | null,
): string[] {
  const args = [
    'exec',
    '--cwd',
    repoPath,
    '--output-format',
    'stream-json',
    '--auto',
    'medium',
    '--model',
    normalizeDroidModelId(model),
  ];
  if (sessionId) {
    args.push('--session-id', sessionId);
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
  const keys = ['content', 'text', 'finalText', 'delta', 'message', 'output', 'result'];
  for (const key of keys) {
    const candidate = pickText(record[key]);
    if (candidate) {
      return candidate;
    }
  }
  for (const key of ['completion', 'part', 'data', 'event']) {
    const candidate = pickText(record[key]);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

export function parseDroidJsonLine(line: string): DroidParsedEvent | null {
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
      cliSource: 'droid',
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
    console.error('[DroidService] Failed to persist message, falling back to realtime broadcast:', error);
    const fallback = createRealtimeMessage({
      projectId,
      role: payload.role,
      messageType: payload.messageType,
      content: payload.content,
      metadata: payload.metadata ?? null,
      cliSource: 'droid',
      requestId,
      ...(realtimeOverrides ?? {}),
    });
    streamManager.publish(projectId, { type: 'message', data: fallback });
  }
}

async function getConfiguredFactoryApiKey(): Promise<string | undefined> {
  const settings = await loadGlobalSettings();
  const candidate = settings.cli_settings?.droid?.apiKey;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

async function executeDroid(
  projectId: string,
  projectPath: string,
  instruction: string,
  model: string,
  sessionId?: string,
  requestId?: string,
): Promise<void> {
  const normalizedModel = normalizeDroidModelId(model);
  const modelDisplayName = getDroidModelDisplayName(normalizedModel);

  publishStatus(projectId, 'starting', requestId);
  if (requestId) {
    await markUserRequestAsRunning(requestId);
  }

  const absoluteProjectPath = await ensureProjectPath(projectId, projectPath);
  const repoPath = await resolveRepoPath(absoluteProjectPath);

  publishStatus(projectId, 'ready', requestId, `Factory Droid CLI detected (${modelDisplayName}). Starting execution...`);

  const promptBase = `${AUTO_INSTRUCTIONS}\n\n${instruction}`.trim();
  const promptWithContext = await appendProjectContext(promptBase, repoPath);
  const apiKey = await getConfiguredFactoryApiKey();

  publishStatus(projectId, 'running', requestId);

  const streamingMessageId = requestId ? `droid-stream-${requestId}` : `droid-stream-${randomUUID()}`;
  const streamingCreatedAt = new Date().toISOString();
  const assistantChunks: string[] = [];
  const stdoutLines: string[] = [];
  const stderrBuffer: string[] = [];
  let lastStreamedContent = '';

  const emitStreamingUpdate = (content: string, { isFinal }: { isFinal: boolean }) => {
    const realtime = createRealtimeMessage({
      id: streamingMessageId,
      projectId,
      role: 'assistant',
      messageType: 'chat',
      content,
      metadata: { cli_type: 'droid' },
      cliSource: 'droid',
      requestId,
      createdAt: streamingCreatedAt,
      isStreaming: !isFinal,
      isFinal,
      isOptimistic: true,
    });
    streamManager.publish(projectId, { type: 'message', data: realtime });
  };

  const child = spawn(DROID_EXECUTABLE, buildDroidExecArgs(promptWithContext, normalizedModel, repoPath, sessionId), {
    cwd: repoPath,
    env: buildDroidEnv(apiKey),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const text = String(chunk).trim();
    if (text) {
      stderrBuffer.push(text);
      console.error('[DroidService][stderr]', text);
    }
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    stdoutLines.push(line);
    const parsed = parseDroidJsonLine(line);
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
      console.error('[DroidService] Failed to start Factory Droid CLI:', error);
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
    await persistAssistantMessage(
      projectId,
      {
        role: 'assistant',
        messageType: 'chat',
        content: finalContent || 'Factory Droid execution completed.',
        metadata: { cli_type: 'droid' },
      },
      requestId,
      { id: streamingMessageId, isStreaming: false, isFinal: true, isOptimistic: false },
    );

    publishStatus(projectId, 'completed', requestId, 'Factory Droid execution completed successfully');
    if (requestId) {
      await markUserRequestAsCompleted(requestId);
    }
    return;
  }

  const stderrText = stderrBuffer.join('\n').trim();
  const errorMessage =
    stderrText ||
    (exitCode === -1
      ? 'Factory Droid CLI is not installed or could not be launched. Install it with curl -fsSL https://app.factory.ai/cli | sh and set FACTORY_API_KEY or sign in.'
      : `Factory Droid CLI exited with status ${exitCode}`);
  const fallbackOutput = stdoutLines
    .map((line) => parseDroidJsonLine(line)?.text)
    .filter((line): line is string => Boolean(line))
    .join('\n')
    .trim();

  publishStatus(projectId, 'completed', requestId, 'Factory Droid execution ended with errors');
  if (requestId) {
    await markUserRequestAsFailed(requestId, errorMessage);
  }

  await persistAssistantMessage(
    projectId,
    {
      role: 'assistant',
      messageType: 'chat',
      content: fallbackOutput
        ? `${fallbackOutput}\n\nFactory Droid CLI reported an error:\n${errorMessage}`
        : `Factory Droid CLI reported an error:\n${errorMessage}`,
      metadata: {
        cli_type: 'droid',
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
  model: string = DROID_DEFAULT_MODEL,
  requestId?: string,
): Promise<void> {
  const fullPrompt = `
Create a new Next.js 15 application with the following requirements:
${initialPrompt}

Use App Router, TypeScript, and Tailwind CSS.
Set up the basic project structure and implement the requested features.`.trim();

  await executeDroid(
    projectId,
    projectPath,
    fullPrompt,
    model ?? getDefaultModelForCli('droid'),
    undefined,
    requestId,
  );
}

export async function applyChanges(
  projectId: string,
  projectPath: string,
  instruction: string,
  model: string = DROID_DEFAULT_MODEL,
  sessionId?: string,
  requestId?: string,
): Promise<void> {
  await executeDroid(
    projectId,
    projectPath,
    instruction,
    model ?? getDefaultModelForCli('droid'),
    sessionId,
    requestId,
  );
}
