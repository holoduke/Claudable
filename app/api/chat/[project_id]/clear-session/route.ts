import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getActiveRequests } from '@/lib/services/user-requests';
import { updateProject } from '@/lib/services/project';
import { resetProjectUsage } from '@/lib/services/agent-usage';
import { createMessage } from '@/lib/services/message';
import { serializeMessage } from '@/lib/serializers/chat';
import { streamManager } from '@/lib/services/stream';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/**
 * `/clear` — drop the agent's conversation context. Clears the Claude session
 * resume pointer so the next message starts a fresh session (chat history in
 * the UI is kept), and resets the usage counters shown in the status panel.
 */
export async function POST(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const denied = await denyUnlessProjectAccess(project_id, { write: true });
    if (denied) return denied;

    if ((await getActiveRequests(project_id)).hasActiveRequests) {
      return NextResponse.json(
        {
          success: false,
          error: 'agent_busy',
          message: 'The agent is still working — stop the current turn before clearing the context.',
        },
        { status: 409 },
      );
    }

    await updateProject(project_id, { activeClaudeSessionId: null });
    await resetProjectUsage(project_id);

    // Visible confirmation in the chat log (also reaches other open viewers via SSE).
    const message = await createMessage({
      projectId: project_id,
      role: 'assistant',
      messageType: 'chat',
      content: '🧹 Context cleared — your next message starts a fresh conversation. Chat history above is kept for reference.',
      cliSource: 'claude',
    });
    streamManager.publish(project_id, {
      type: 'message',
      data: serializeMessage(message),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] Failed to clear agent session:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to clear agent session',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
