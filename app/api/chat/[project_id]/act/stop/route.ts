/**
 * POST /api/chat/[project_id]/act/stop — interrupt the project's running agent
 * turn (CLI parity with pressing Esc in Claude Code). Kills the live process
 * via the run registry, then force-fails any still-active request rows and
 * publishes a terminal status so the UI never stays stuck, even if the owning
 * run died without cleanup.
 */

import { NextRequest, NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { interruptAgentRun } from '@/lib/services/cli/run-registry';
import { streamManager } from '@/lib/services/stream';
import { prisma } from '@/lib/db/client';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ project_id: string }> }
) {
  try {
    const { project_id: projectId } = await params;

    const gate = await denyUnlessProjectAccess(projectId, { write: true });
    if (gate) return gate;

    const { interrupted, requestId } = interruptAgentRun(projectId);

    await prisma.userRequest.updateMany({
      where: { projectId, status: { in: ['pending', 'processing', 'active', 'running'] } },
      data: { status: 'failed', errorMessage: 'Stopped by user', completedAt: new Date() },
    });

    streamManager.publish(projectId, {
      type: 'status',
      data: {
        status: 'completed',
        message: 'Stopped by user',
        ...(requestId ? { requestId } : {}),
      },
    });

    return NextResponse.json({ success: true, data: { interrupted } });
  } catch (error) {
    console.error('[act/stop] Failed to stop agent turn:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to stop the running turn' },
      { status: 500 }
    );
  }
}
