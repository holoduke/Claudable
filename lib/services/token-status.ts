import { prisma } from '@/lib/db/client';
import { authEnabled, getAdminUser } from '@/lib/auth/session';

export const TOKEN_PROVIDERS = ['github', 'supabase', 'vercel'] as const;
export type TokenProvider = (typeof TOKEN_PROVIDERS)[number];

export interface ServiceTokenStatus {
  providers: Record<TokenProvider, { configured: boolean }>;
  /** Whether the caller may add/replace provider tokens (POST /api/tokens is admin-only). */
  can_manage_tokens: boolean;
}

/**
 * Which org-global provider tokens exist — booleans only, never token values
 * or ids — plus whether the caller can set them up. Safe to expose to any
 * project writer: the Deploy tab needs it to decide between "Connect",
 * "Setup Token" (admins) and "Ask an admin" (everyone else).
 */
export async function getServiceTokenStatus(): Promise<ServiceTokenStatus> {
  const rows = await prisma.serviceToken.findMany({
    where: { provider: { in: [...TOKEN_PROVIDERS] } },
    select: { provider: true },
  });
  const present = new Set(rows.map((row) => row.provider));
  const providers = Object.fromEntries(
    TOKEN_PROVIDERS.map((provider) => [provider, { configured: present.has(provider) }]),
  ) as ServiceTokenStatus['providers'];
  // With the auth gate off every caller is effectively admin (gates are no-ops).
  const canManage = !authEnabled() || (await getAdminUser()) !== null;
  return { providers, can_manage_tokens: canManage };
}
