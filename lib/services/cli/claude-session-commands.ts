import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'path';
import fs from 'fs/promises';
import { getProjectById, updateProject } from '@/lib/services/project';
import { streamManager } from '@/lib/services/stream';

type ClaudeSlashCommand = 'compact' | 'clear';

function getAllowedProjectsBasePath(): string {
  return path.resolve(process.cwd(), process.env.PROJECTS_DIR || './data/projects');
}

export function buildClaudeSlashCommandPrompt(
  command: ClaudeSlashCommand,
  instructions?: string | null,
): string {
  if (command === 'clear') {
    return '/clear';
  }

  const sanitizedInstructions = instructions
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

  return sanitizedInstructions ? `/compact ${sanitizedInstructions}` : '/compact';
}

export function isClaudeContextLimitError(message: string): boolean {
  return /input length and max_tokens exceed context limit/i.test(message) ||
    /prompt is too long/i.test(message) ||
    /context limit/i.test(message);
}

function resolveProjectPath(projectId: string, repoPath?: string | null): string {
  const allowedBasePath = getAllowedProjectsBasePath();
  const projectPath = repoPath
    ? path.isAbsolute(repoPath)
      ? path.resolve(repoPath)
      : path.resolve(process.cwd(), repoPath)
    : path.resolve(allowedBasePath, projectId);
  const relativeToBase = path.relative(allowedBasePath, projectPath);
  const isWithinBase = !relativeToBase.startsWith('..') && !path.isAbsolute(relativeToBase);

  if (!isWithinBase) {
    throw new Error('Security violation: Project path must be within the configured projects directory');
  }

  return projectPath;
}

async function ensureProjectPath(projectPath: string): Promise<string> {
  await fs.mkdir(projectPath, { recursive: true });
  return projectPath;
}

async function runClaudeSessionCommand(
  projectId: string,
  command: ClaudeSlashCommand,
  instructions?: string | null,
) {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error('Project not found');
  }
  if ((project.preferredCli ?? 'claude') !== 'claude') {
    throw new Error('Claude session commands are only available for Claude Code projects');
  }
  if (!project.activeClaudeSessionId) {
    throw new Error('No active Claude session to compact or clear');
  }

  const projectPath = await ensureProjectPath(resolveProjectPath(projectId, project.repoPath));
  const prompt = buildClaudeSlashCommandPrompt(command, instructions);
  const actionLabel = command === 'compact' ? 'compact' : 'clear';

  streamManager.publish(projectId, {
    type: 'status',
    data: {
      status: command === 'compact' ? 'compacting' : 'clearing',
      message: command === 'compact' ? 'Compacting Claude context...' : 'Clearing Claude session...',
    },
  });

  let nextSessionId: string | undefined;
  let sawCompactBoundary = false;

  try {
    const response = query({
      prompt,
      options: {
        workingDirectory: projectPath,
        additionalDirectories: [projectPath],
        resume: project.activeClaudeSessionId,
        maxTurns: 1,
      } as any,
    });

    for await (const message of response) {
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        nextSessionId = message.session_id;
      }

      if (message.type === 'stream_event') {
        const event = (message as any).event;
        if (event?.type === 'compact_boundary') {
          sawCompactBoundary = true;
        }
      }
    }

    if (nextSessionId && nextSessionId !== project.activeClaudeSessionId) {
      await updateProject(projectId, { activeClaudeSessionId: nextSessionId });
    }

    streamManager.publish(projectId, {
      type: 'status',
      data: {
        status: 'completed',
        message:
          command === 'compact'
            ? sawCompactBoundary
              ? 'Claude context compacted.'
              : 'Claude compact command completed.'
            : 'Claude session cleared.',
      },
    });

    return {
      sessionId: nextSessionId ?? project.activeClaudeSessionId,
      compactBoundary: sawCompactBoundary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : `Failed to ${actionLabel} Claude session`;
    streamManager.publish(projectId, {
      type: 'status',
      data: {
        status: 'error',
        message,
      },
    });
    streamManager.publish(projectId, {
      type: 'error',
      error: message,
    });
    throw error;
  }
}

export function compactClaudeSession(projectId: string, instructions?: string | null) {
  return runClaudeSessionCommand(projectId, 'compact', instructions);
}

export function clearClaudeSession(projectId: string) {
  return runClaudeSessionCommand(projectId, 'clear');
}
