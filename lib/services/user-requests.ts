import { prisma } from '@/lib/db/client';
import { Prisma } from '@prisma/client';

export interface ActiveRequestSummary {
  hasActiveRequests: boolean;
  activeCount: number;
}

/**
 * A request that has been "active" longer than this is treated as dead.
 * Real agent runs stream continuously and finish well within this window;
 * anything older is a zombie left by a crash/abort that never hit its
 * terminal-status finally block. Acts as a backstop to startup reconciliation
 * for processes that stay up but lose a run.
 *
 * MUST exceed the agent turn's own hang-timeout (30 min in claude-container.ts),
 * else a legitimate long turn loses its DB lock while the container is still
 * running and a second turn could start alongside it. The in-memory run registry
 * is the real per-turn concurrency gate now; this is only the cross-restart
 * backstop, so we keep a comfortable margin over the container cap.
 */
const ACTIVE_REQUEST_STALE_MS = 35 * 60 * 1000; // 35 minutes (> 30-min container cap)

export async function getActiveRequests(projectId: string): Promise<ActiveRequestSummary> {
  const staleCutoff = new Date(Date.now() - ACTIVE_REQUEST_STALE_MS);

  const count = await prisma.userRequest.count({
    where: {
      projectId,
      status: {
        in: ['pending', 'processing', 'active', 'running'],
      },
      // Ignore zombie rows whose owning run has clearly died.
      createdAt: { gte: staleCutoff },
    },
  });

  return {
    hasActiveRequests: count > 0,
    activeCount: count,
  };
}

/**
 * The project a request row belongs to, or null if the id is unknown. Used by the
 * act route to reject a client-supplied requestId that collides with another
 * project's request (the id is a global PK).
 */
export async function getUserRequestProjectId(id: string): Promise<string | null> {
  const row = await prisma.userRequest.findUnique({
    where: { id },
    select: { projectId: true },
  });
  return row?.projectId ?? null;
}

export type UserRequestStatus =
  | 'pending'
  | 'processing'
  | 'active'
  | 'running'
  | 'completed'
  | 'failed';

interface UpsertUserRequestOptions {
  id: string;
  projectId: string;
  instruction: string;
  cliPreference?: string | null;
}

async function handleNotFound(error: unknown, context: string): Promise<void> {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2025'
  ) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[UserRequests] ${context}: record not found`);
    }
    return;
  }

  throw error;
}

/**
 * Create or update a user request record.
 * Uses the client-provided requestId as the primary key.
 */
export async function upsertUserRequest({
  id,
  projectId,
  instruction,
  cliPreference,
}: UpsertUserRequestOptions) {
  return prisma.userRequest.upsert({
    where: { id },
    create: {
      id,
      projectId,
      instruction,
      status: 'pending',
      ...(cliPreference !== undefined ? { cliPreference } : {}),
    },
    update: {
      instruction,
      ...(cliPreference !== undefined ? { cliPreference } : {}),
    },
  });
}

async function updateStatus(
  id: string,
  status: UserRequestStatus,
  options: { errorMessage?: string | null; setCompletionTimestamp?: boolean } = {}
) {
  try {
    const data: Prisma.UserRequestUpdateInput = {
      status,
    };

    if (options.setCompletionTimestamp ?? (status === 'completed' || status === 'failed')) {
      data.completedAt = new Date();
    } else if (status === 'pending' || status === 'processing' || status === 'running' || status === 'active') {
      data.completedAt = null;
    }

    if ('errorMessage' in options) {
      data.errorMessage = options.errorMessage ?? null;
    } else if (status !== 'failed') {
      data.errorMessage = null;
    }

    await prisma.userRequest.update({
      where: { id },
      data,
    });
  } catch (error) {
    await handleNotFound(error, `update status to ${status}`);
  }
}

export async function markUserRequestAsRunning(id: string): Promise<void> {
  await updateStatus(id, 'running');
}

export async function markUserRequestAsProcessing(id: string): Promise<void> {
  await updateStatus(id, 'processing');
}

export async function markUserRequestAsCompleted(id: string): Promise<void> {
  await updateStatus(id, 'completed', {
    errorMessage: null,
    setCompletionTimestamp: true,
  });
}

export async function markUserRequestAsFailed(
  id: string,
  errorMessage?: string,
): Promise<void> {
  await updateStatus(id, 'failed', {
    errorMessage: errorMessage ?? 'Request failed',
    setCompletionTimestamp: true,
  });
}
