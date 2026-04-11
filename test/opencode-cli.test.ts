import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  getProjectById: vi.fn(),
  updateProject: vi.fn(),
  updateProjectActivity: vi.fn(),
  createMessage: vi.fn(),
  publish: vi.fn(),
  previewGetStatus: vi.fn(),
  previewStart: vi.fn(),
  upsertUserRequest: vi.fn(),
  markUserRequestAsProcessing: vi.fn(),
  initializeClaudeProject: vi.fn(),
  applyClaudeChanges: vi.fn(),
  initializeCodexProject: vi.fn(),
  applyCodexChanges: vi.fn(),
  initializeCursorProject: vi.fn(),
  applyCursorChanges: vi.fn(),
  initializeQwenProject: vi.fn(),
  applyQwenChanges: vi.fn(),
  initializeGLMProject: vi.fn(),
  applyGLMChanges: vi.fn(),
  initializeOpenCodeProject: vi.fn(),
  applyOpenCodeChanges: vi.fn(),
}));

vi.mock('child_process', () => ({
  exec: mocks.exec,
}));

vi.mock('@/lib/services/project', () => ({
  getProjectById: mocks.getProjectById,
  updateProject: mocks.updateProject,
  updateProjectActivity: mocks.updateProjectActivity,
}));

vi.mock('@/lib/services/message', () => ({
  createMessage: mocks.createMessage,
}));

vi.mock('@/lib/services/stream', () => ({
  streamManager: {
    publish: mocks.publish,
  },
}));

vi.mock('@/lib/services/preview', () => ({
  previewManager: {
    getStatus: mocks.previewGetStatus,
    start: mocks.previewStart,
  },
}));

vi.mock('@/lib/services/user-requests', () => ({
  upsertUserRequest: mocks.upsertUserRequest,
  markUserRequestAsProcessing: mocks.markUserRequestAsProcessing,
  markUserRequestAsRunning: vi.fn(),
  markUserRequestAsCompleted: vi.fn(),
  markUserRequestAsFailed: vi.fn(),
}));

vi.mock('@/lib/serializers/chat', () => ({
  serializeMessage: vi.fn((message, extra) => ({ ...message, ...extra })),
  createRealtimeMessage: vi.fn((message) => message),
}));

vi.mock('@/lib/services/cli/claude', () => ({
  initializeNextJsProject: mocks.initializeClaudeProject,
  applyChanges: mocks.applyClaudeChanges,
}));

vi.mock('@/lib/services/cli/codex', () => ({
  initializeNextJsProject: mocks.initializeCodexProject,
  applyChanges: mocks.applyCodexChanges,
}));

vi.mock('@/lib/services/cli/cursor', () => ({
  initializeNextJsProject: mocks.initializeCursorProject,
  applyChanges: mocks.applyCursorChanges,
}));

vi.mock('@/lib/services/cli/qwen', () => ({
  initializeNextJsProject: mocks.initializeQwenProject,
  applyChanges: mocks.applyQwenChanges,
}));

vi.mock('@/lib/services/cli/glm', () => ({
  initializeNextJsProject: mocks.initializeGLMProject,
  applyChanges: mocks.applyGLMChanges,
}));

vi.mock('@/lib/services/cli/opencode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/services/cli/opencode')>();
  return {
    ...actual,
    initializeNextJsProject: mocks.initializeOpenCodeProject,
    applyChanges: mocks.applyOpenCodeChanges,
  };
});

import {
  buildOpenCodeRunArgs,
  getActiveOpenCodeSessionId,
  mergeActiveOpenCodeSessionId,
  parseOpenCodeJsonLine,
} from '../lib/services/cli/opencode';
import {
  OPENCODE_DEFAULT_MODEL,
  normalizeOpenCodeModelId,
} from '../lib/constants/opencodeModels';
import { ACTIVE_CLI_IDS, buildCustomModelOptionForCli, isValidCustomModelForCli } from '../lib/utils/cliOptions';
import { GET as cliStatusGet } from '../app/api/settings/cli-status/route';
import { POST as actPost } from '../app/api/chat/[project_id]/act/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exec.mockImplementation((command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, `${command} version 1.0.0\n`, '');
  });
  mocks.getProjectById.mockResolvedValue({
    id: 'project-1',
    name: 'Project 1',
    preferredCli: 'claude',
    selectedModel: 'claude-sonnet-4-6',
    settings: JSON.stringify({ activeOpenCodeSessionId: 'session-1' }),
    repoPath: `${process.cwd()}/data/projects/project-1`,
    activeClaudeSessionId: null,
    activeCursorSessionId: null,
  });
  mocks.createMessage.mockResolvedValue({
    id: 'message-1',
    projectId: 'project-1',
    role: 'user',
    messageType: 'chat',
    content: 'Build a button',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  mocks.updateProject.mockResolvedValue({});
  mocks.updateProjectActivity.mockResolvedValue(undefined);
  mocks.previewGetStatus.mockReturnValue({ url: 'http://localhost:3000' });
  mocks.previewStart.mockResolvedValue(undefined);
  mocks.upsertUserRequest.mockResolvedValue(undefined);
  mocks.markUserRequestAsProcessing.mockResolvedValue(undefined);
  mocks.applyOpenCodeChanges.mockResolvedValue(undefined);
  mocks.initializeOpenCodeProject.mockResolvedValue(undefined);
});

describe('OpenCode model and argument helpers', () => {
  it('normalizes known provider/model ids and falls back to the default', () => {
    expect(normalizeOpenCodeModelId('openai/gpt-5.4')).toBe('openai/gpt-5.4');
    expect(normalizeOpenCodeModelId('anthropic/custom-model')).toBe('anthropic/custom-model');
    expect(normalizeOpenCodeModelId('unknown')).toBe(OPENCODE_DEFAULT_MODEL);
  });

  it('allows valid custom OpenCode provider/model ids outside the curated list', () => {
    expect(isValidCustomModelForCli('opencode', 'anthropic/custom-model')).toBe(true);
    expect(isValidCustomModelForCli('opencode', 'openai/gpt-5.4')).toBe(false);
    expect(isValidCustomModelForCli('claude', 'anthropic/custom-model')).toBe(false);
    expect(isValidCustomModelForCli('opencode', 'unknown')).toBe(false);
  });

  it('builds a selectable option for custom OpenCode models', () => {
    expect(buildCustomModelOptionForCli('opencode', 'Anthropic/Custom-Model')).toEqual({
      id: 'anthropic/custom-model',
      name: 'anthropic/custom-model',
      cli: 'opencode',
      cliName: 'OpenCode',
      available: true,
    });
    expect(buildCustomModelOptionForCli('opencode', 'openai/gpt-5.4')).toBeNull();
  });

  it('builds opencode run args with JSON output and model selection', () => {
    expect(buildOpenCodeRunArgs('Fix the navbar', 'openai/gpt-5.4')).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      'openai/gpt-5.4',
      'Fix the navbar',
    ]);
  });

  it('adds an OpenCode session id when resuming a session', () => {
    expect(buildOpenCodeRunArgs('Fix the navbar', 'openai/gpt-5.4', 'session-1')).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      'openai/gpt-5.4',
      '--session',
      'session-1',
      'Fix the navbar',
    ]);
  });
});

describe('OpenCode session settings', () => {
  it('reads and merges the active OpenCode session id from project settings JSON', () => {
    const merged = mergeActiveOpenCodeSessionId('{"theme":"dark"}', 'session-1');

    expect(JSON.parse(merged)).toEqual({
      theme: 'dark',
      activeOpenCodeSessionId: 'session-1',
    });
    expect(getActiveOpenCodeSessionId(merged)).toBe('session-1');
  });
});

describe('parseOpenCodeJsonLine', () => {
  it('extracts assistant text from JSON events', () => {
    expect(parseOpenCodeJsonLine('{"type":"message","content":"Done"}')).toEqual({
      type: 'assistant',
      text: 'Done',
      raw: { type: 'message', content: 'Done' },
    });
  });

  it('returns null for malformed JSON event lines', () => {
    expect(parseOpenCodeJsonLine('{bad json')).toBeNull();
  });
});

describe('OpenCode integration points', () => {
  it('exposes opencode as an active CLI option and status entry', async () => {
    expect(ACTIVE_CLI_IDS).toContain('opencode');

    const response = await cliStatusGet();
    const body = await response.json();

    expect(body.opencode).toMatchObject({
      checking: false,
    });
    expect(body.opencode.models).toContain(OPENCODE_DEFAULT_MODEL);
  });

  it('routes act requests to the OpenCode executor', async () => {
    const response = await actPost(
      new Request('http://localhost/api/chat/project-1/act', {
        method: 'POST',
        body: JSON.stringify({
          instruction: 'Build a button',
          cliPreference: 'opencode',
          selectedModel: 'openai/gpt-5.4',
          requestId: 'request-1',
        }),
      }) as any,
      { params: Promise.resolve({ project_id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.applyOpenCodeChanges).toHaveBeenCalledWith(
      'project-1',
      `${process.cwd()}/data/projects/project-1`,
      'Build a button',
      'openai/gpt-5.4',
      'session-1',
      'request-1',
    );
    expect(mocks.applyClaudeChanges).not.toHaveBeenCalled();
  });
});
