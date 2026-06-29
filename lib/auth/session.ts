import { auth } from './index';
import { prisma } from '@/lib/db/client';
import type { User } from '@prisma/client';

/**
 * Resolve the current request's user from the session, loading fresh from the DB
 * so role/isActive changes take effect without re-login. Returns null if not
 * signed in or deactivated. Use in server components and API route handlers.
 */
export async function getSessionUser(): Promise<User | null> {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email) return null;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive) return null;
  return user;
}

/** True when the auth gate is active (set once login is confirmed working). */
export function authEnabled(): boolean {
  return process.env.AUTH_ENABLED === 'true';
}

/**
 * Resolve the current user only if they are an active admin, else null.
 * Used to gate the user-management API regardless of AUTH_ENABLED — admin
 * operations always require a signed-in admin, even while the gate is off.
 */
export async function getAdminUser(): Promise<User | null> {
  const user = await getSessionUser();
  return user && user.role === 'admin' ? user : null;
}
