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
 *   const denied = await denyUnlessProjectAccess(project_id);       // read
 *   const denied = await denyUnlessProjectAccess(project_id, { manage: true }); // write/manage
 *   const denied = await denyUnlessAdmin();                          // org-global
 *   if (denied) return denied;
 */
import { getSessionUser, getAdminUser, authEnabled } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canAccessProject, canManageProject } from '@/lib/services/project-access';

function deny(status: number, code: string, message: string): Response {
  return Response.json({ success: false, error: code, message }, { status });
}

/**
 * Require that the caller may access (or, with `manage`, manage) the project.
 * Returns a Response to short-circuit the handler, or null to proceed.
 */
export async function denyUnlessProjectAccess(
  projectId: string,
  opts?: { manage?: boolean },
): Promise<Response | null> {
  if (!authEnabled()) return null;
  const user = await getSessionUser();
  if (!user) return deny(401, 'unauthorized', 'Authentication required');
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return deny(404, 'not_found', 'Project not found');
  const ok = opts?.manage ? canManageProject(user, project) : await canAccessProject(user, project);
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
