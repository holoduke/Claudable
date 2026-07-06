/**
 * Shared agent-message handling for BOTH agent execution paths:
 *  - the in-process Agent SDK loop (executeClaude), and
 *  - the containerized runner (runContainerizedTurn / claude-container.ts).
 *
 * Extracted verbatim from claude.ts so the containerized agent renders the
 * SAME chat output (thinking blocks, tool cards, placeholder protocol,
 * session persistence) as the in-process path. Any change here affects both.
 */
import { streamManager } from '../stream';
import { serializeMessage, createRealtimeMessage } from '@/lib/serializers/chat';
import { createMessage } from '../message';
import { updateProject } from '../project';
import { markRateLimitExhausted, recordAssistantUsage, recordRateLimit, recordTurnResult } from '../agent-usage';

/**
 * Detect the CLI's subscription-limit refusal ("You've hit your limit ·
 * resets 2:10pm (UTC)") in an assistant reply. Returns the parsed reset time
 * (ISO) when found, `null` for a limit reply without a parsable time, and
 * `undefined` when the reply is not a limit refusal at all.
 */
function detectUsageLimitReply(content: string): string | null | undefined {
  if (!/\byou'?ve hit your (usage )?limit\b/i.test(content)) return undefined;
  const m = content.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?UTC\)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute));
  if (reset.getTime() <= now.getTime()) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset.toISOString();
}
import {
  type ToolAction,
  pickFirstString,
  buildToolMetadata,
  inferActionFromToolName,
} from './tool-metadata';

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

export const dispatchToolMessage = async ({
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

export const handleToolPlaceholderMessage = async (
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

/** What processMessage recognized (callers key follow-up bookkeeping off this). */
export type AgentMessageKind = 'init' | 'assistant' | 'result' | null;

export interface AgentMessageProcessorContext {
  projectId: string;
  requestId?: string;
  /** Called with the SDK/CLI session id as soon as it's known (for resume bookkeeping). */
  onSessionId?: (sessionId: string) => void;
  publishStatus: (status: string, message?: string) => void;
  /** Marks the user request completed (idempotent — the caller guards re-entry). */
  markCompleted: () => Promise<void>;
}

/**
 * Stateful processor for whole agent messages (system/init, assistant, result) —
 * the message shapes shared by the in-process SDK loop and the containerized
 * CLI's stream-json output. Owns the placeholder/tool-card dedupe state; the
 * in-process partial-streaming branch reuses that state via the exposed members.
 */
export function createAgentMessageProcessor(ctx: AgentMessageProcessorContext) {
  const placeholderHistory = new Map<string, Set<string>>();
  const persistedToolMessageSignatures = new Set<string>();
  const completedStreamSessions = new Set<string>();

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

  const processMessage = async (message: {
    type?: string;
    subtype?: string;
    session_id?: unknown;
    uuid?: unknown;
    message?: unknown;
  }): Promise<AgentMessageKind> => {
    const { projectId, requestId } = ctx;

    if (message.type === 'system' && message.subtype === 'init') {
      const currentSessionId = typeof message.session_id === 'string' ? message.session_id : undefined;
      console.log(`[ClaudeService] Session initialized: ${currentSessionId}`);

      if (currentSessionId) {
        ctx.onSessionId?.(currentSessionId);
        // Save session ID to project (resume target for the next turn)
        await updateProject(projectId, {
          activeClaudeSessionId: currentSessionId,
        });
      }

      streamManager.publish(projectId, {
        type: 'connected',
        data: {
          projectId,
          sessionId: currentSessionId,
          timestamp: new Date().toISOString(),
          connectionStage: 'assistant',
        },
      });
      return 'init';
    }

    if (message.type === 'rate_limit_event') {
      // Subscription window utilization (5-hour / weekly) — account-wide.
      recordRateLimit(projectId, (message as Record<string, unknown>).rate_limit_info);
      return null;
    }

    if (message.type === 'assistant') {
      const sessionKey = (message.session_id ?? message.uuid ?? 'default').toString();
      const assistantMessage = message.message as {
        content?: unknown;
        usage?: unknown;
        model?: unknown;
      };
      // Tokens currently in the context window (prompt incl. cache + output).
      // BEFORE the stream-dedupe early-return: the in-process path handles the
      // content via stream events, but the usage only rides the whole message.
      recordAssistantUsage(projectId, assistantMessage?.usage, assistantMessage?.model);

      if (completedStreamSessions.has(sessionKey)) {
        completedStreamSessions.delete(sessionKey);
        return 'assistant';
      }

      let content = '';

      // Extract content
      if (typeof assistantMessage?.content === 'string') {
        content = assistantMessage.content;
      } else if (Array.isArray(assistantMessage?.content)) {
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
        // Subscription-limit refusal → make it unmissable: flag the message for
        // the chat's warning banner + peg the 5h meter (the containerized CLI
        // emits no rate_limit_event, so this reply is the only signal).
        const limitResetsAt = detectUsageLimitReply(content);
        if (limitResetsAt !== undefined) {
          markRateLimitExhausted(projectId, limitResetsAt ?? undefined);
        }
        const savedMessage = await createMessage({
          projectId,
          role: 'assistant',
          messageType: 'chat',
          content,
          ...(limitResetsAt !== undefined
            ? { metadata: { usageLimit: true, ...(limitResetsAt ? { resetsAt: limitResetsAt } : {}) } }
            : {}),
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
      return 'assistant';
    }

    if (message.type === 'result') {
      // Final result
      console.log('[ClaudeService] Task completed:', message.subtype);
      // Per-turn tokens/cost + context window → status panel (persist + publish).
      try {
        await recordTurnResult(projectId, message);
      } catch (error) {
        console.error('[ClaudeService] Failed to record turn usage:', error);
      }
      ctx.publishStatus('completed');
      await ctx.markCompleted();
      return 'result';
    }

    return null;
  };

  return {
    processMessage,
    markPlaceholderHandled,
    persistedToolMessageSignatures,
    completedStreamSessions,
  };
}
