/**
 * Organisation membership + role policy (Prisma — Node only).
 *
 * Membership (OrgMember) is the tenant boundary: a user reaches an org's
 * projects and people because they hold a membership in that org — not because
 * of the legacy User.orgId "home org" field (which now only picks defaults:
 * where a new project lands when no org is chosen, and where sign-in
 * provisioning files a brand-new user).
 *
 * Roles inside an org: eigenaar > beheerder > lid.
 *   - eigenaar / beheerder manage the org's MEMBERS (add, remove, change role).
 *     They get no extra project access — a restricted project stays visible
 *     only to its owner and assigned members.
 *   - a beheerder can neither hand out the eigenaar role nor touch an eigenaar.
 *   - the last eigenaar of an org can never be demoted or removed (orgs.ts).
 *
 * Global admins (User.role === 'admin') are New Story staff: superadmin over
 * every organisation. That is a deliberately separate concept from org roles.
 */
import { prisma } from '@/lib/db/client';
import { getSessionUser } from '@/lib/auth/session';
import type { User } from '@prisma/client';

export type OrgRole = 'eigenaar' | 'beheerder' | 'lid';

export function isSuperadmin(user: { role: string }): boolean {
  return user.role === 'admin';
}

export function isOrgAdminRole(role: string | null | undefined): role is 'eigenaar' | 'beheerder' {
  return role === 'eigenaar' || role === 'beheerder';
}

/** orgId -> role for every organisation the user is a member of. */
export async function orgMembershipMap(userId: string): Promise<Map<string, OrgRole>> {
  const rows = await prisma.orgMember.findMany({
    where: { userId },
    select: { orgId: true, role: true },
  });
  return new Map(rows.map((r) => [r.orgId, r.role as OrgRole]));
}

/** The set of organisation ids the user belongs to. */
export async function orgIdsFor(userId: string): Promise<Set<string>> {
  return new Set((await orgMembershipMap(userId)).keys());
}

export async function isOrgMember(userId: string, orgId: string | null | undefined): Promise<boolean> {
  if (!orgId) return false;
  const row = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { id: true },
  });
  return !!row;
}

/** Who is acting on an org: the user, whether they are staff, and their org role (if any). */
export interface OrgActor {
  user: User;
  superadmin: boolean;
  role: OrgRole | null;
}

export type OrgGate =
  | { ok: true; actor: OrgActor }
  | { ok: false; status: number; code: string; message: string };

async function resolveActor(orgId: string): Promise<OrgGate> {
  const user = await getSessionUser();
  if (!user) return { ok: false, status: 401, code: 'unauthorized', message: 'Sign in required' };
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) return { ok: false, status: 404, code: 'not_found', message: 'Organisation not found' };
  const membership = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId: user.id } },
    select: { role: true },
  });
  return {
    ok: true,
    actor: { user, superadmin: isSuperadmin(user), role: (membership?.role as OrgRole | undefined) ?? null },
  };
}

/** Any member of the org, or a superadmin. */
export async function requireOrgMember(orgId: string): Promise<OrgGate> {
  const gate = await resolveActor(orgId);
  if (!gate.ok) return gate;
  if (gate.actor.superadmin || gate.actor.role) return gate;
  return { ok: false, status: 403, code: 'forbidden', message: 'You are not a member of this organisation' };
}

/** An eigenaar or beheerder of the org, or a superadmin. */
export async function requireOrgManager(orgId: string): Promise<OrgGate> {
  const gate = await resolveActor(orgId);
  if (!gate.ok) return gate;
  if (gate.actor.superadmin || isOrgAdminRole(gate.actor.role)) return gate;
  return { ok: false, status: 403, code: 'forbidden', message: 'Only an eigenaar or beheerder can manage members' };
}

/** Whether members of this org may create new projects (superadmin-controlled flag). */
export async function orgAllowsProjectCreation(orgId: string): Promise<boolean> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { canCreateProjects: true } });
  return !!org?.canCreateProjects;
}

/**
 * Role policy for member mutations. `targetRole` is the role the affected
 * member currently holds (null when adding someone new); `newRole` is the role
 * being assigned (null when removing).
 */
export function canActorSetRole(
  actor: Pick<OrgActor, 'superadmin' | 'role'>,
  targetRole: OrgRole | null,
  newRole: OrgRole | null,
): boolean {
  if (actor.superadmin) return true;
  if (actor.role === 'eigenaar') return true;
  if (actor.role === 'beheerder') {
    if (targetRole === 'eigenaar') return false; // may not touch an owner
    if (newRole === 'eigenaar') return false; // may not create an owner
    return true;
  }
  return false;
}
