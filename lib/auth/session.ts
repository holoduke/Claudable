import { headers } from 'next/headers';
import { auth } from './index';
import { prisma } from '@/lib/db/client';
import type { User } from '@prisma/client';
import { bearerToken } from './api-token-signature';
import { resolveApiTokenUser } from './api-token';

export type RequestAuth = { user: User; via: 'session' | 'token' };

/**
 * Resolve who is making this request: the signed-in session first, otherwise a personal API
 * token in `Authorization: Bearer clb_…` (see lib/auth/api-token.ts). Loads fresh from the DB so
 * role/isActive changes take effect immediately. Returns null if neither is valid.
 */
export async function getRequestAuth(): Promise<RequestAuth | null> {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (email) {
    const user = await prisma.user.findUnique({ where: { email } });
    return user && user.isActive ? { user, via: 'session' } : null;
  }
  let header: string | null = null;
  try {
    header = (await headers()).get('authorization');
  } catch {
    return null; // outside a request scope (build time, scripts)
  }
  const token = bearerToken(header);
  if (!token) return null;
  const user = await resolveApiTokenUser(token);
  return user ? { user, via: 'token' } : null;
}

/**
 * Resolve the current request's user (session or API token). Returns null if not signed in or
 * deactivated. Use in server components and API route handlers.
 */
export async function getSessionUser(): Promise<User | null> {
  return (await getRequestAuth())?.user ?? null;
}

/** True when the auth gate is active (set once login is confirmed working). */
export function authEnabled(): boolean {
  return process.env.AUTH_ENABLED === 'true';
}

/**
 * Resolve the current user only if they are an active admin, else null.
 * Used to gate the user-management API regardless of AUTH_ENABLED — admin
 * operations always require a signed-in admin, even while the gate is off.
 * An API token never grants admin rights, even when it belongs to an admin.
 */
export async function getAdminUser(): Promise<User | null> {
  const current = await getRequestAuth();
  return current && current.via === 'session' && current.user.role === 'admin' ? current.user : null;
}
