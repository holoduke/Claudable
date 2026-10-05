import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getActiveRequests } from '@/lib/services/user-requests';
import { postChatNotice, resetAgentSession } from '@/lib/services/cli/agent-session';

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

    await resetAgentSession(project_id);

    // Visible confirmation in the chat log (also reaches other open viewers via SSE).
    await postChatNotice(
      project_id,
      '🧹 Context cleared — your next message starts a fresh conversation. Chat history above is kept for reference.',
    );

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
