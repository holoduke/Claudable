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
 *   const denied = await denyUnlessProjectAccess(project_id, { write: true, configure: true }); // project settings
 *   const denied = await denyUnlessAdmin();                          // org-global
 *   if (denied) return denied;
 *
 * Three tiers: read < write < manage. `write` lets an editor member (or any
 * org user on an org-visible project) run the agent, edit files/env values and
 * deploy; `manage` is owner/admin only — reserved for reading/setting secrets,
 * destroying containers/databases, and deleting/reconfiguring the project.
 *
 * In a CUSTOMER project, `manage` and `configure` (the project's settings: skills,
 * MCP, plugins, design, credentials, …) are New Story staff only — the customer
 * uses the project (chat, preview, publish) but configures nothing.
 */
import { getSessionUser, getAdminUser, authEnabled } from '@/lib/auth/session';
import { isCustomerProject, isInternalUser } from '@/lib/services/tenant-policy';
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
  opts?: { manage?: boolean; write?: boolean; configure?: boolean },
): Promise<Response | null> {
  if (!authEnabled()) return null;
  const user = await getSessionUser();
  if (!user) return deny(401, 'unauthorized', 'Authentication required');
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  // Someone who may not even READ the project gets the same 404 as for a
  // project that does not exist: a 403 would confirm that the id is real.
  if (!project || !(await canAccessProject(user, project))) return deny(404, 'not_found', 'Project not found');
  if (opts?.manage && !canManageProject(user, project)) return deny(403, 'forbidden', 'Access denied');
  if (opts?.write && !opts?.manage && !(await canWriteProject(user, project))) return deny(403, 'forbidden', 'Access denied');
  if ((opts?.manage || opts?.configure) && (await isCustomerProject(projectId)) && !(await isInternalUser(user))) {
    return deny(403, 'forbidden', 'This setting is managed by New Story');
  }
  return null;
}

/** Require an active admin (org-global resources: provider tokens, Supabase account, etc.). */
export async function denyUnlessAdmin(): Promise<Response | null> {
  if (!authEnabled()) return null;
  const user = await getAdminUser();
  if (!user) return deny(403, 'forbidden', 'Admin access required');
  return null;
}

/**
 * Require New Story staff (a superadmin or a member of a non-customer org) —
 * for New Story-internal lookups a customer-only user must not reach.
 */
export async function denyUnlessInternal(): Promise<Response | null> {
  if (!authEnabled()) return null;
  const user = await getSessionUser();
  if (!user) return deny(401, 'unauthorized', 'Authentication required');
  if (!(await isInternalUser(user))) return deny(403, 'forbidden', 'Access denied');
  return null;
}

/** Require any signed-in user (no project scope). */
export async function denyUnlessSignedIn(): Promise<Response | null> {
  if (!authEnabled()) return null;
  const user = await getSessionUser();
  if (!user) return deny(401, 'unauthorized', 'Authentication required');
  return null;
}
