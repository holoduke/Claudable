import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../stream', () => ({ streamManager: { publish: vi.fn() } }));
vi.mock('@/lib/serializers/chat', () => ({ serializeMessage: (m: unknown) => m, createRealtimeMessage: (m: unknown) => m }));
vi.mock('../message', () => ({ createMessage: vi.fn(async (m: Record<string, unknown>) => ({ id: 'm1', ...m })) }));
vi.mock('../project', () => ({ updateProject: vi.fn(async () => undefined) }));
vi.mock('../agent-usage', () => ({
  markRateLimitExhausted: vi.fn(),
  recordAssistantUsage: vi.fn(),
  recordRateLimit: vi.fn(async () => undefined),
  recordTurnResult: vi.fn(async () => undefined),
}));
vi.mock('../run-cost', () => ({ bookRunResult: vi.fn(async () => undefined) }));

import { assistantContentHasOutput, createAgentMessageProcessor, isSuccessfulResult } from './agent-messages';

function makeProcessor() {
  const publishStatus = vi.fn();
  const markCompleted = vi.fn(async () => undefined);
  const processor = createAgentMessageProcessor({ projectId: 'p1', requestId: 'r1', publishStatus, markCompleted });
  return { processor, publishStatus, markCompleted };
}

describe('isSuccessfulResult', () => {
  it('only accepts the success subtype', () => {
    expect(isSuccessfulResult({ subtype: 'success' })).toBe(true);
    expect(isSuccessfulResult({ subtype: 'error_during_execution' })).toBe(false);
    expect(isSuccessfulResult({ subtype: 'error_max_turns' })).toBe(false);
    expect(isSuccessfulResult({})).toBe(false);
  });
});

describe('assistantContentHasOutput', () => {
  it('detects text, thinking and tool calls', () => {
    expect(assistantContentHasOutput([{ type: 'text', text: 'hi' }])).toBe(true);
    expect(assistantContentHasOutput([{ type: 'thinking', thinking: 'hmm' }])).toBe(true);
    expect(assistantContentHasOutput([{ type: 'tool_use', name: 'Edit', input: {} }])).toBe(true);
    expect(assistantContentHasOutput('plain')).toBe(true);
  });
  it('ignores empty content', () => {
    expect(assistantContentHasOutput([{ type: 'text', text: '   ' }])).toBe(false);
    expect(assistantContentHasOutput([])).toBe(false);
    expect(assistantContentHasOutput(undefined)).toBe(false);
    expect(assistantContentHasOutput('')).toBe(false);
  });
});

describe('createAgentMessageProcessor — result handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks completed and publishes completed for a success result', async () => {
    const { processor, publishStatus, markCompleted } = makeProcessor();
    expect(await processor.processMessage({ type: 'result', subtype: 'success' })).toBe('result');
    expect(markCompleted).toHaveBeenCalledTimes(1);
    expect(publishStatus).toHaveBeenCalledWith('completed');
    expect(processor.failedResultSubtype()).toBeUndefined();
  });

  it.each(['error_during_execution', 'error_max_turns'])('does NOT complete a %s result', async (subtype) => {
    const { processor, publishStatus, markCompleted } = makeProcessor();
    expect(await processor.processMessage({ type: 'result', subtype })).toBe('result_error');
    expect(markCompleted).not.toHaveBeenCalled();
    expect(publishStatus).not.toHaveBeenCalledWith('completed');
    expect(processor.failedResultSubtype()).toBe(subtype);
  });

  it('tracks whether the turn produced output', async () => {
    const { processor } = makeProcessor();
    expect(processor.hasProducedOutput()).toBe(false);
    await processor.processMessage({ type: 'system', subtype: 'init', session_id: 's1' });
    expect(processor.hasProducedOutput()).toBe(false);
    await processor.processMessage({
      type: 'assistant',
      session_id: 's1',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/work/a.ts' } }] },
    });
    expect(processor.hasProducedOutput()).toBe(true);
  });
});
