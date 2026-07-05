/**
 * Per-project access control (Prisma, Node only).
 *
 * A project is either open to the whole org (visibility "org") or restricted to
 * an explicit set of members (visibility "restricted"). The owner and global
 * admins can always manage and access it. Enforcement (hiding restricted
 * projects) is applied by the API routes only when the auth gate is enabled.
 */
import { prisma } from '@/lib/db/client';
import { getSessionUser } from '@/lib/auth/session';
import type { User, Project } from '@prisma/client';

export type Visibility = 'org' | 'restricted';

/** Result of the owner-or-admin gate used by the access/member routes. */
export type ManagerGate =
  | { ok: true; user: User; project: Project }
  | { ok: false; status: number; code: string; message: string };

/** Resolve the signed-in manager for a project, or a typed denial. */
export async function requireProjectManager(projectId: string): Promise<ManagerGate> {
  const user = await getSessionUser();
  if (!user) return { ok: false, status: 401, code: 'unauthorized', message: 'Sign in required' };
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return { ok: false, status: 404, code: 'not_found', message: 'Project not found' };
  if (!canManageProject(user, project)) {
    return { ok: false, status: 403, code: 'forbidden', message: 'Only the project owner or an admin can manage access' };
  }
  return { ok: true, user, project };
}

type AccessProject = {
  id: string;
  ownerId: string | null;
  orgId: string | null;
  visibility: string;
};

/** Owner or global admin may toggle restriction and assign members. */
export function canManageProject(user: User, project: { ownerId: string | null }): boolean {
  return user.role === 'admin' || project.ownerId === user.id;
}

/**
 * Whether a user may WRITE to a project (run the agent, edit files/env, deploy,
 * revert) — a middle tier between read (canAccessProject) and manage
 * (owner/admin only). This is what finally makes the `ProjectMember.role`
 * column meaningful: on a restricted project a `viewer` member can open it but
 * NOT write; an `editor` member can. Org-visible projects stay collaborative
 * (any same-org user may write), matching prior behaviour.
 */
export async function canWriteProject(user: User, project: AccessProject): Promise<boolean> {
  if (user.role === 'admin') return true;
  if (project.ownerId === user.id) return true;
  if (project.visibility !== 'restricted') {
    return project.orgId == null || project.orgId === user.orgId;
  }
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: project.id, userId: user.id } },
  });
  return member?.role === 'editor';
}

/** Whether a user may see/open a project at all. */
export async function canAccessProject(user: User, project: AccessProject): Promise<boolean> {
  if (user.role === 'admin') return true;
  if (project.ownerId === user.id) return true;
  if (project.visibility !== 'restricted') {
    // Open to the org. Legacy projects (orgId null) stay visible to everyone.
    return project.orgId == null || project.orgId === user.orgId;
  }
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: project.id, userId: user.id } },
  });
  return !!member;
}

export async function getProjectAccess(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return null;
  const members = await prisma.projectMember.findMany({
    where: { projectId },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });
  return {
    visibility: (project.visibility === 'restricted' ? 'restricted' : 'org') as Visibility,
    members: members.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      name: m.user.name,
      image: m.user.image,
    })),
  };
}

export async function setProjectVisibility(projectId: string, visibility: Visibility) {
  return prisma.project.update({ where: { id: projectId }, data: { visibility } });
}

/** Idempotent: adding an already-assigned user is a no-op. */
export async function addProjectMember(projectId: string, userId: string) {
  await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId, userId } },
    update: {},
    create: { projectId, userId },
  });
}

export async function removeProjectMember(projectId: string, userId: string) {
  await prisma.projectMember.deleteMany({ where: { projectId, userId } });
}

/**
 * The ids of `projects` that `user` may see. Restricted-project memberships are
 * resolved in a single query to avoid N+1. Returns a Set so the caller can
 * filter its own (richly-typed) project array without type gymnastics.
 */
export async function accessibleProjectIds(
  user: User,
  projects: AccessProject[],
): Promise<Set<string>> {
  if (user.role === 'admin') return new Set(projects.map((p) => p.id));

  const restrictedIds = projects
    .filter((p) => p.visibility === 'restricted' && p.ownerId !== user.id)
    .map((p) => p.id);

  let memberIds = new Set<string>();
  if (restrictedIds.length) {
    const memberships = await prisma.projectMember.findMany({
      where: { userId: user.id, projectId: { in: restrictedIds } },
      select: { projectId: true },
    });
    memberIds = new Set(memberships.map((m) => m.projectId));
  }

  return new Set(
    projects
      .filter((p) => {
        if (p.ownerId === user.id) return true;
        if (p.visibility !== 'restricted') return p.orgId == null || p.orgId === user.orgId;
        return memberIds.has(p.id);
      })
      .map((p) => p.id),
  );
}

/** Org-scoped active-user search powering the assignment autocomplete. */
export async function searchOrgUsers(orgId: string, query: string, limit = 10) {
  const q = query.trim();
  // SQLite LIKE is case-insensitive for ASCII, so `contains` needs no mode flag
  // (which SQLite doesn't support anyway).
  const users = await prisma.user.findMany({
    where: {
      orgId,
      isActive: true,
      ...(q ? { OR: [{ email: { contains: q } }, { name: { contains: q } }] } : {}),
    },
    take: limit,
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
  });
  return users.map((u) => ({ id: u.id, email: u.email, name: u.name, image: u.image }));
}
