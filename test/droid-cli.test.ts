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
  initializeDroidProject: vi.fn(),
  applyDroidChanges: vi.fn(),
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

vi.mock('@/lib/services/cli/opencode', () => ({
  initializeNextJsProject: mocks.initializeOpenCodeProject,
  applyChanges: mocks.applyOpenCodeChanges,
  getActiveOpenCodeSessionId: vi.fn(() => undefined),
}));

vi.mock('@/lib/services/cli/droid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/services/cli/droid')>();
  return {
    ...actual,
    initializeNextJsProject: mocks.initializeDroidProject,
    applyChanges: mocks.applyDroidChanges,
  };
});

import {
  buildDroidEnv,
  buildDroidExecArgs,
  parseDroidJsonLine,
} from '../lib/services/cli/droid';
import {
  DROID_DEFAULT_MODEL,
  normalizeDroidModelId,
} from '../lib/constants/droidModels';
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
    settings: '{}',
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
  mocks.applyDroidChanges.mockResolvedValue(undefined);
  mocks.initializeDroidProject.mockResolvedValue(undefined);
});

describe('Droid model and argument helpers', () => {
  it('normalizes known model ids and supports Factory custom aliases', () => {
    expect(normalizeDroidModelId('gpt-5.4')).toBe('gpt-5.4');
    expect(normalizeDroidModelId('CUSTOM:team-router')).toBe('custom:team-router');
    expect(normalizeDroidModelId('unknown')).toBe(DROID_DEFAULT_MODEL);
  });

  it('allows valid Droid custom aliases outside the curated list', () => {
    expect(isValidCustomModelForCli('droid', 'custom:team-router')).toBe(true);
    expect(isValidCustomModelForCli('droid', 'gpt-5.4')).toBe(false);
    expect(isValidCustomModelForCli('opencode', 'custom:team-router')).toBe(false);
    expect(isValidCustomModelForCli('droid', 'provider/model')).toBe(false);
  });

  it('builds a selectable option for custom Droid aliases', () => {
    expect(buildCustomModelOptionForCli('droid', 'CUSTOM:team-router')).toEqual({
      id: 'custom:team-router',
      name: 'custom:team-router',
      cli: 'droid',
      cliName: 'Factory Droid',
      available: true,
    });
    expect(buildCustomModelOptionForCli('droid', 'gpt-5.4')).toBeNull();
  });

  it('builds droid exec args with cwd, stream JSON output, autonomy, and model selection', () => {
    expect(buildDroidExecArgs('Fix the navbar', 'gpt-5.4', '/repo')).toEqual([
      'exec',
      '--cwd',
      '/repo',
      '--output-format',
      'stream-json',
      '--auto',
      'medium',
      '--model',
      'gpt-5.4',
      'Fix the navbar',
    ]);
  });

  it('adds a Droid session id when resuming a session', () => {
    expect(buildDroidExecArgs('Fix the navbar', 'gpt-5.4', '/repo', 'session-1')).toEqual([
      'exec',
      '--cwd',
      '/repo',
      '--output-format',
      'stream-json',
      '--auto',
      'medium',
      '--model',
      'gpt-5.4',
      '--session-id',
      'session-1',
      'Fix the navbar',
    ]);
  });

  it('injects FACTORY_API_KEY without changing logs or arguments', () => {
    const env = buildDroidEnv('fk-secret');

    expect(env.FACTORY_API_KEY).toBe('fk-secret');
    expect(buildDroidExecArgs('Fix the navbar', 'gpt-5.4', '/repo').join(' ')).not.toContain('fk-secret');
  });
});

describe('parseDroidJsonLine', () => {
  it('extracts assistant text from stream JSON events', () => {
    expect(parseDroidJsonLine('{"type":"message","content":"Done"}')).toEqual({
      type: 'assistant',
      text: 'Done',
      raw: { type: 'message', content: 'Done' },
    });
  });

  it('extracts assistant text from Factory completion.finalText events', () => {
    expect(parseDroidJsonLine('{"type":"completion","completion":{"finalText":"Done from Droid"}}')).toEqual({
      type: 'assistant',
      text: 'Done from Droid',
      raw: { type: 'completion', completion: { finalText: 'Done from Droid' } },
    });
  });

  it('returns null for malformed JSON event lines', () => {
    expect(parseDroidJsonLine('{bad json')).toBeNull();
  });
});

describe('Droid integration points', () => {
  it('exposes droid as an active CLI option and status entry', async () => {
    expect(ACTIVE_CLI_IDS).toContain('droid');

    const response = await cliStatusGet();
    const body = await response.json();

    expect(body.droid).toMatchObject({
      checking: false,
    });
    expect(body.droid.models).toContain(DROID_DEFAULT_MODEL);
  });

  it('routes act requests to the Droid executor', async () => {
    const response = await actPost(
      new Request('http://localhost/api/chat/project-1/act', {
        method: 'POST',
        body: JSON.stringify({
          instruction: 'Build a button',
          cliPreference: 'droid',
          selectedModel: 'gpt-5.4',
          requestId: 'request-1',
        }),
      }) as any,
      { params: Promise.resolve({ project_id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.applyDroidChanges).toHaveBeenCalledWith(
      'project-1',
      `${process.cwd()}/data/projects/project-1`,
      'Build a button',
      'gpt-5.4',
      undefined,
      'request-1',
    );
    expect(mocks.applyClaudeChanges).not.toHaveBeenCalled();
  });
});
