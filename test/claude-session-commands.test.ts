import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getProjectById: vi.fn(),
  updateProject: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mocks.query,
}));

vi.mock('@/lib/services/project', () => ({
  getProjectById: mocks.getProjectById,
  updateProject: mocks.updateProject,
}));

vi.mock('@/lib/services/stream', () => ({
  streamManager: {
    publish: mocks.publish,
  },
}));

import {
  buildClaudeSlashCommandPrompt,
  clearClaudeSession,
  compactClaudeSession,
  isClaudeContextLimitError,
} from '../lib/services/cli/claude-session-commands';
import { POST as compactPost } from '../app/api/chat/[project_id]/compact/route';

const allowedRepoPath = `${process.cwd()}/data/projects/project-1`;

async function* streamMessages(messages: any[]) {
  for (const message of messages) {
    yield message;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildClaudeSlashCommandPrompt', () => {
  it('builds a clear slash command', () => {
    expect(buildClaudeSlashCommandPrompt('clear')).toBe('/clear');
  });

  it('builds a compact slash command without instructions', () => {
    expect(buildClaudeSlashCommandPrompt('compact')).toBe('/compact');
  });

  it('builds a compact slash command with single-line sanitized instructions', () => {
    expect(
      buildClaudeSlashCommandPrompt(
        'compact',
        'Preserve decisions.\nKeep current task state.',
      ),
    ).toBe('/compact Preserve decisions. Keep current task state.');
  });
});

describe('isClaudeContextLimitError', () => {
  it('detects Claude input length context errors', () => {
    expect(
      isClaudeContextLimitError(
        'input length and max_tokens exceed context limit: 198981 + 21333 > 200000',
      ),
    ).toBe(true);
  });

  it('detects prompt too long errors', () => {
    expect(isClaudeContextLimitError('Prompt is too long')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isClaudeContextLimitError('Claude Code CLI not installed')).toBe(false);
  });
});

describe('compactClaudeSession', () => {
  it('sends /compact to the active Claude session and records a new session id', async () => {
    mocks.getProjectById.mockResolvedValue({
      id: 'project-1',
      preferredCli: 'claude',
      activeClaudeSessionId: 'session-old',
      repoPath: allowedRepoPath,
    });
    mocks.query.mockReturnValue(streamMessages([
      { type: 'system', subtype: 'init', session_id: 'session-new' },
      { type: 'stream_event', event: { type: 'compact_boundary' } },
    ]));

    const result = await compactClaudeSession('project-1', 'Keep current task state.');

    expect(mocks.query).toHaveBeenCalledWith({
      prompt: '/compact Keep current task state.',
      options: expect.objectContaining({
        workingDirectory: allowedRepoPath,
        additionalDirectories: [allowedRepoPath],
        resume: 'session-old',
        maxTurns: 1,
      }),
    });
    expect(mocks.updateProject).toHaveBeenCalledWith('project-1', {
      activeClaudeSessionId: 'session-new',
    });
    expect(mocks.publish).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        type: 'status',
        data: expect.objectContaining({ status: 'compacting' }),
      }),
    );
    expect(mocks.publish).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        type: 'status',
        data: expect.objectContaining({
          status: 'completed',
          message: 'Claude context compacted.',
        }),
      }),
    );
    expect(result).toEqual({
      sessionId: 'session-new',
      compactBoundary: true,
    });
  });

  it('rejects non-Claude projects', async () => {
    mocks.getProjectById.mockResolvedValue({
      id: 'project-1',
      preferredCli: 'cursor',
      activeClaudeSessionId: 'session-old',
      repoPath: allowedRepoPath,
    });

    await expect(compactClaudeSession('project-1')).rejects.toThrow('Claude session commands are only available');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects projects without an active Claude session', async () => {
    mocks.getProjectById.mockResolvedValue({
      id: 'project-1',
      preferredCli: 'claude',
      activeClaudeSessionId: null,
      repoPath: allowedRepoPath,
    });

    await expect(compactClaudeSession('project-1')).rejects.toThrow('No active Claude session');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects repo paths outside the configured projects directory', async () => {
    mocks.getProjectById.mockResolvedValue({
      id: 'project-1',
      preferredCli: 'claude',
      activeClaudeSessionId: 'session-old',
      repoPath: process.cwd(),
    });

    await expect(compactClaudeSession('project-1')).rejects.toThrow(
      'Security violation: Project path must be within the configured projects directory',
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('publishes a terminal error status when the Claude SDK call fails', async () => {
    mocks.getProjectById.mockResolvedValue({
      id: 'project-1',
      preferredCli: 'claude',
      activeClaudeSessionId: 'session-old',
      repoPath: allowedRepoPath,
    });
    mocks.query.mockImplementation(() => {
      throw new Error('SDK failed');
    });

    await expect(compactClaudeSession('project-1')).rejects.toThrow('SDK failed');
    expect(mocks.publish).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        type: 'status',
        data: expect.objectContaining({ status: 'error', message: 'SDK failed' }),
      }),
    );
    expect(mocks.publish).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        type: 'error',
        error: 'SDK failed',
      }),
    );
  });
});

describe('clearClaudeSession', () => {
  it('sends /clear and updates the active session when Claude returns a new id', async () => {
    mocks.getProjectById.mockResolvedValue({
      id: 'project-1',
      preferredCli: 'claude',
      activeClaudeSessionId: 'session-old',
      repoPath: allowedRepoPath,
    });
    mocks.query.mockReturnValue(streamMessages([
      { type: 'system', subtype: 'init', session_id: 'session-cleared' },
    ]));

    const result = await clearClaudeSession('project-1');

    expect(mocks.query).toHaveBeenCalledWith({
      prompt: '/clear',
      options: expect.objectContaining({
        resume: 'session-old',
        maxTurns: 1,
      }),
    });
    expect(mocks.updateProject).toHaveBeenCalledWith('project-1', {
      activeClaudeSessionId: 'session-cleared',
    });
    expect(result).toEqual({
      sessionId: 'session-cleared',
      compactBoundary: false,
    });
  });
});

describe('compact route', () => {
  it('returns 404 for a missing project', async () => {
    mocks.getProjectById.mockResolvedValue(null);

    const response = await compactPost(
      new Request('http://localhost/api/chat/missing/compact', {
        method: 'POST',
        body: JSON.stringify({}),
      }) as any,
      { params: Promise.resolve({ project_id: 'missing' }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Project not found',
    });
  });

  it('returns 409 when there is no active Claude session', async () => {
    mocks.getProjectById.mockResolvedValue({
      id: 'project-1',
      preferredCli: 'claude',
      activeClaudeSessionId: null,
      repoPath: allowedRepoPath,
    });

    const response = await compactPost(
      new Request('http://localhost/api/chat/project-1/compact', {
        method: 'POST',
        body: JSON.stringify({}),
      }) as any,
      { params: Promise.resolve({ project_id: 'project-1' }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'No active Claude session to compact or clear',
    });
  });

  it('returns a safe 400 response for invalid project paths', async () => {
    mocks.getProjectById.mockResolvedValue({
      id: 'project-1',
      preferredCli: 'claude',
      activeClaudeSessionId: 'session-old',
      repoPath: process.cwd(),
    });

    const response = await compactPost(
      new Request('http://localhost/api/chat/project-1/compact', {
        method: 'POST',
        body: JSON.stringify({}),
      }) as any,
      { params: Promise.resolve({ project_id: 'project-1' }) },
    );

    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: 'Security violation: Project path must be within the configured projects directory',
    });
    expect(body.error).not.toContain(process.cwd());
  });
});
