/**
 * Agent conversation-context helpers shared by `/clear` (clear-session) and a
 * checkpoint revert: both make the agent's transcript stale, so the next turn
 * must start a fresh Claude session instead of resuming it.
 */
import { updateProject } from '@/lib/services/project';
import { resetProjectUsage } from '@/lib/services/agent-usage';
import { createMessage } from '@/lib/services/message';
import { serializeMessage } from '@/lib/serializers/chat';
import { streamManager } from '@/lib/services/stream';

/** Drop the resume pointer (next turn = fresh session) and reset the context/usage counters. */
export async function resetAgentSession(projectId: string): Promise<void> {
  await updateProject(projectId, { activeClaudeSessionId: null });
  await resetProjectUsage(projectId);
}

/** Persist a visible notice in the chat log and push it to every open viewer. */
export async function postChatNotice(projectId: string, content: string): Promise<void> {
  const message = await createMessage({
    projectId,
    role: 'assistant',
    messageType: 'chat',
    content,
    cliSource: 'claude',
  });
  streamManager.publish(projectId, { type: 'message', data: serializeMessage(message) });
}
