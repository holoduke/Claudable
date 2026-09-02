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

/** Every account on this installation (superadmin view), admins first then alphabetical. */
export async function listUsers(): Promise<User[]> {
  return prisma.user.findMany({
    orderBy: [{ role: 'asc' }, { email: 'asc' }],
  });
}

export async function setUserItops(id: string, itopsEnabled: boolean): Promise<User> {
  return prisma.user.update({ where: { id }, data: { itopsEnabled: Boolean(itopsEnabled) } });
}

/** Persist a user's preferred UI language (null clears it → follow the default). */
export async function setUserLocale(id: string, locale: string | null): Promise<User> {
  return prisma.user.update({ where: { id }, data: { locale } });
}

/**
 * Delete an account. Org-level Claude credentials this person happened to set
 * are re-owned by the acting admin first — `ClaudeCredential.owner` cascades,
 * and an organisation must not lose its credential because its setter left.
 */
export async function deleteUser(id: string, reassignOrgCredentialsTo?: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (reassignOrgCredentialsTo && reassignOrgCredentialsTo !== id) {
      await tx.claudeCredential.updateMany({
        where: { ownerId: id, organizations: { some: {} } },
        data: { ownerId: reassignOrgCredentialsTo },
      });
    }
    await tx.user.delete({ where: { id } });
  });
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
    locale: (u as { locale?: string | null }).locale ?? null,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}
