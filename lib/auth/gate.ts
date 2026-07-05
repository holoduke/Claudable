/**
 * Per-request authorization gates for API route handlers.
 *
 * IMPORTANT: every gate is a NO-OP while the auth gate is off (AUTH_ENABLED !=
 * 'true'). That preserves today's single-user / VPN behaviour exactly — nothing
 * changes until auth is flipped on — and then these gates engage uniformly so a
 * logged-in user can only reach projects they may access and only admins can
 * touch org-global resources.
 *
 * Usage in a handler:
 *   const denied = await denyUnlessProjectAccess(project_id);        // read  (view/open)
 *   const denied = await denyUnlessProjectAccess(project_id, { write: true });  // write (agent/edit/deploy)
 *   const denied = await denyUnlessProjectAccess(project_id, { manage: true }); // manage (owner/admin: secrets, DB drop, delete)
 *   const denied = await denyUnlessAdmin();                          // org-global
 *   if (denied) return denied;
 *
 * Three tiers: read < write < manage. `write` lets an editor member (or any
 * org user on an org-visible project) run the agent, edit files/env values and
 * deploy; `manage` is owner/admin only — reserved for reading/setting secrets,
 * destroying containers/databases, and deleting/reconfiguring the project.
 */
import { getSessionUser, getAdminUser, authEnabled } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canAccessProject, canManageProject, canWriteProject } from '@/lib/services/project-access';

function deny(status: number, code: string, message: string): Response {
  return Response.json({ success: false, error: code, message }, { status });
}

/**
 * Require that the caller may access (or, with `manage`, manage) the project.
 * Returns a Response to short-circuit the handler, or null to proceed.
 */
export async function denyUnlessProjectAccess(
  projectId: string,
  opts?: { manage?: boolean; write?: boolean },
): Promise<Response | null> {
  if (!authEnabled()) return null;
  const user = await getSessionUser();
  if (!user) return deny(401, 'unauthorized', 'Authentication required');
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return deny(404, 'not_found', 'Project not found');
  const ok = opts?.manage
    ? canManageProject(user, project)
    : opts?.write
      ? await canWriteProject(user, project)
      : await canAccessProject(user, project);
  if (!ok) return deny(403, 'forbidden', 'Access denied');
  return null;
}

/** Require an active admin (org-global resources: provider tokens, Supabase account, etc.). */
export async function denyUnlessAdmin(): Promise<Response | null> {
  if (!authEnabled()) return null;
  const user = await getAdminUser();
  if (!user) return deny(403, 'forbidden', 'Admin access required');
  return null;
}

/** Require any signed-in user (no project scope). */
export async function denyUnlessSignedIn(): Promise<Response | null> {
  if (!authEnabled()) return null;
  const user = await getSessionUser();
  if (!user) return deny(401, 'unauthorized', 'Authentication required');
  return null;
}
