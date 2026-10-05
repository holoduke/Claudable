/**
 * POST /api/projects/[project_id]/checkpoints/revert  { sha }
 * Forward-restore the project's source to a checkpoint (the state after a past
 * agent turn). Non-destructive to checkpoint history.
 *
 * Holds the project's agent run slot for the duration of the restore, so no turn
 * can start writing files mid-restore (409 while a turn is running). Afterwards
 * the agent session is reset — its transcript describes edits that are no longer
 * on disk — and a notice is posted in the chat.
 */
import { NextRequest } from 'next/server';
import path from 'path';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canWriteProject } from '@/lib/services/project-access';
import { getProjectById } from '@/lib/services/project';
import { revertToCheckpoint } from '@/lib/services/checkpoints';
import { isRestricted, resolveEditProfile } from '@/lib/services/edit-profiles';
import { getActiveRequests } from '@/lib/services/user-requests';
import { releaseAgentRun, setReservedRequestId, tryReserveAgentRun } from '@/lib/services/cli/run-registry';
import { postChatNotice, resetAgentSession } from '@/lib/services/cli/agent-session';
import { randomUUID } from 'crypto';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR) ? PROJECTS_DIR : path.resolve(/* turbopackIgnore: true */ process.cwd(), PROJECTS_DIR);

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const project = await getProjectById(project_id);
    if (!project) return createErrorResponse('not_found', 'Project not found', 404);
    if (authEnabled()) {
      const user = await getSessionUser();
      if (!user) return createErrorResponse('unauthorized', 'Authentication required', 401);
      const dbProject = await prisma.project.findUnique({ where: { id: project_id } });
      if (!dbProject || !(await canWriteProject(user, dbProject))) return createErrorResponse('forbidden', 'Access denied', 403);
      // Reverting restores the whole tree (code included): full edit profile only.
      const { profile } = await resolveEditProfile(project_id, user.id);
      if (isRestricted(profile)) return createErrorResponse('forbidden', `Your edit profile "${profile.label}" does not allow reverting`, 403);
    }

    const body = (await request.json().catch(() => null)) ?? {};
    const sha = typeof body.sha === 'string' ? body.sha.trim() : '';
    if (!/^[0-9a-f]{7,40}$/iu.test(sha)) return createErrorResponse('invalid', 'A valid checkpoint sha is required', 400);

    const projectPath = path.resolve(
      project.repoPath
        ? (path.isAbsolute(project.repoPath) ? project.repoPath : path.resolve(/* turbopackIgnore: true */ process.cwd(), project.repoPath))
        : path.join(PROJECTS_DIR_ABSOLUTE, project_id),
    );
    // Revert runs `git clean -fd` in projectPath — refuse if it isn't inside the
    // projects sandbox (guards a legacy/crafted repoPath from an unbounded clean).
    if (projectPath !== PROJECTS_DIR_ABSOLUTE && !projectPath.startsWith(PROJECTS_DIR_ABSOLUTE + path.sep)) {
      return createErrorResponse('forbidden', 'Project path is outside the projects directory', 400);
    }

    // Don't revert while an agent turn is running, and don't let one START while
    // we restore: the executor's file writes would race `git restore` +
    // `git clean -fd`, and its end-of-turn snapshot would capture a half-reverted
    // tree. Take the same atomic run slot the act route takes (it answers 409
    // "busy" while we hold it), tagged so only OUR release frees it.
    const busy = () => createErrorResponse('busy', 'The agent is still working — wait for it to finish before reverting', 409);
    if (!tryReserveAgentRun(project_id)) return busy();
    const slotTag = `revert-${randomUUID()}`;
    setReservedRequestId(project_id, slotTag);
    try {
      // Durable backstop: a run from before a server restart isn't in the registry.
      if ((await getActiveRequests(project_id)).hasActiveRequests) return busy();

      const result = await revertToCheckpoint(project_id, projectPath, sha);
      if (!result.ok) return createErrorResponse('revert_failed', result.error || 'Revert failed', 400);

      // The agent's transcript now describes edits that are gone: start the next
      // turn in a fresh session (same reset as /clear). Best-effort after a
      // successful restore — the files are already reverted.
      await resetAgentSession(project_id).catch((e) => console.error('[API] revert: session reset failed:', e));
      await postChatNotice(
        project_id,
        `↩️ Reverted to ${sha.slice(0, 7)}. The assistant starts a fresh conversation from this version; the chat history above is kept for reference.`,
      ).catch((e) => console.error('[API] revert: chat notice failed:', e));

      return createSuccessResponse({ reverted: true, newSha: result.newSha ?? null, sessionReset: true });
    } finally {
      releaseAgentRun(project_id, slotTag);
    }
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to revert checkpoint');
  }
}
