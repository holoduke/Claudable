/**
 * User management (admin operations) — Prisma, Node only.
 *
 * Backs the admin "Users" settings tab: list members of the organization,
 * pre-authorize external emails, change roles, and activate/deactivate.
 * Access control (admin-only, no self-lockout) is enforced in the API routes;
 * these functions are pure data operations.
 */
import { prisma } from '@/lib/db/client';
import { ensureOrg } from '@/lib/auth/provision';
import type { User } from '@prisma/client';

export type Role = 'admin' | 'user';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

/** All users, admins first then alphabetical — the admin sees the whole org. */
export async function listUsers(): Promise<User[]> {
  return prisma.user.findMany({ orderBy: [{ role: 'asc' }, { email: 'asc' }] });
}

/**
 * Pre-authorize an external email (outside the allowed domain) by creating a
 * dormant User row. Their first Google sign-in then succeeds and fills in
 * name/image. Idempotent: returns the existing row if already present.
 */
export async function addExternalUser(email: string, name?: string | null): Promise<User> {
  const lower = email.trim().toLowerCase();
  if (!EMAIL_RE.test(lower)) {
    throw new Error('A valid email address is required');
  }
  const existing = await prisma.user.findUnique({ where: { email: lower } });
  if (existing) return existing;

  const org = await ensureOrg();
  return prisma.user.create({
    data: {
      email: lower,
      name: name?.trim() || null,
      role: 'user',
      orgId: org.id,
      isActive: true,
    },
  });
}

export async function setUserRole(id: string, role: Role): Promise<User> {
  if (role !== 'admin' && role !== 'user') {
    throw new Error('Role must be "admin" or "user"');
  }
  return prisma.user.update({ where: { id }, data: { role } });
}

export async function setUserActive(id: string, isActive: boolean): Promise<User> {
  return prisma.user.update({ where: { id }, data: { isActive: Boolean(isActive) } });
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
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}
