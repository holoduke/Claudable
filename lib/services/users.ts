/**
 * User management (admin operations) — Prisma, Node only.
 *
 * Backs the admin "Users" settings tab: list members of the organization,
 * pre-authorize external emails, change roles, and activate/deactivate.
 * Access control (admin-only, no self-lockout) is enforced in the API routes;
 * these functions are pure data operations.
 */
import { prisma } from '@/lib/db/client';
import type { User } from '@prisma/client';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

/**
 * Members of one org, admins first then alphabetical. Scoped by orgId so that
 * when a second org is added an admin can never see/manage another org's users.
 */
export async function listUsers(orgId: string): Promise<User[]> {
  return prisma.user.findMany({
    where: { orgId },
    orderBy: [{ role: 'asc' }, { email: 'asc' }],
  });
}

/**
 * Pre-authorize an external email (outside the allowed domain) by creating a
 * dormant User row. Their first Google sign-in then succeeds and fills in
 * name/image. Idempotent: returns the existing row (created: false) if already
 * present, tolerating a concurrent insert (P2002) without surfacing a 500.
 */
export async function addExternalUser(
  orgId: string,
  email: string,
  name?: string | null,
): Promise<{ user: User; created: boolean }> {
  const lower = email.trim().toLowerCase();
  if (!EMAIL_RE.test(lower)) {
    throw new Error('A valid email address is required');
  }
  const existing = await prisma.user.findUnique({ where: { email: lower } });
  if (existing) return { user: existing, created: false };

  try {
    const user = await prisma.user.create({
      data: {
        email: lower,
        name: name?.trim() || null,
        role: 'user',
        orgId,
        isActive: true,
      },
    });
    return { user, created: true };
  } catch (error) {
    // Lost a race with a concurrent invite/sign-in for the same email.
    if ((error as { code?: string })?.code === 'P2002') {
      const raced = await prisma.user.findUnique({ where: { email: lower } });
      if (raced) return { user: raced, created: false };
    }
    throw error;
  }
}

export async function setUserItops(id: string, itopsEnabled: boolean): Promise<User> {
  return prisma.user.update({ where: { id }, data: { itopsEnabled: Boolean(itopsEnabled) } });
}

export async function deleteUser(id: string): Promise<void> {
  await prisma.user.delete({ where: { id } });
}

/** Shape sent to the client — never leak anything beyond these fields. */
export function serializeUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    image: u.image,
    role: u.role,
    isActive: u.isActive,
    itopsEnabled: u.itopsEnabled,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}
