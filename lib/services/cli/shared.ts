/**
 * Shared helpers for the CLI adapters (codex / cursor / glm / qwen).
 *
 * Extracted VERBATIM from the adapters — only helpers whose bodies were
 * byte-identical across files live here (adapter-specific bits like the
 * status-label table or the log tag are passed in as parameters). Variants
 * that diverge between adapters (message persistence, tool dispatch,
 * failure handling) intentionally stay in each adapter.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { streamManager } from '@/lib/services/stream';
import { getProjectById } from '@/lib/services/project';

/**
 * Returns the adapter's `publishStatus(projectId, status, requestId?, message?)`
 * bound to its own status-label table.
 */
export function createStatusPublisher(statusLabels: Record<string, string>) {
  return function publishStatus(
    projectId: string,
    status: string,
    requestId?: string,
    message?: string,
  ) {
    streamManager.publish(projectId, {
      type: 'status',
      data: {
        status,
        message: message ?? statusLabels[status] ?? '',
        ...(requestId ? { requestId } : {}),
      },
    });
  };
}

export async function ensureProjectPath(projectId: string, projectPath: string): Promise<string> {
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
    throw new Error(`Project path must be within ${allowedBasePath}. Got: ${absolute}`);
  }

  try {
    await fs.access(absolute);
  } catch {
    await fs.mkdir(absolute, { recursive: true });
  }

  return absolute;
}

/**
 * Appends a <current_project_context> listing of the repo's visible files to
 * the instruction. `logTag` is the adapter's log prefix (e.g. '[CodexService]').
 * NOTE: cursor.ts keeps its own copy — its context wording differs.
 */
export async function appendProjectContext(
  baseInstruction: string,
  repoPath: string,
  logTag: string,
): Promise<string> {
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
    console.warn(`${logTag} Failed to append project context:`, error);
    return baseInstruction;
  }
}

/**
 * Prefer the `repo` subdirectory when it exists (and is a directory),
 * otherwise fall back to the project root.
 */
export async function resolveRepoPath(absoluteProjectPath: string): Promise<string> {
  const candidate = path.join(absoluteProjectPath, 'repo');
  try {
    const stats = await fs.stat(candidate);
    if (stats.isDirectory()) {
      return candidate;
    }
  } catch {
    // ignore
  }
  return absoluteProjectPath;
}

/**
 * A copy of process.env with the npm global dir (and, on Windows, the npm /
 * nodejs app dirs) prepended to PATH so the spawned CLI binary is found.
 */
export function buildPathEnrichedEnv(): NodeJS.ProcessEnv {
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
    const existing = env.PATH || env.Path || '';
    env.PATH = [...additionalPaths, existing].filter(Boolean).join(path.delimiter);
  }
  return env;
}
