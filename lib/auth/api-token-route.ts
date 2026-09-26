/**
 * Shared guard for the token-management routes (/api/users/me/api-tokens*).
 * - A real session is required: a token can neither list nor mint tokens, so a leaked token cannot
 *   create a longer-lived copy of itself.
 * - Mutations must come from the app itself. SameSite=Lax cookies already stop cross-site POSTs; the
 *   Sec-Fetch-Site check is defence in depth because one forged request would mint a long-lived credential.
 */
import type { User } from '@prisma/client';
import { getRequestAuth } from './session';

export async function tokenManager(request: Request, { mutation }: { mutation: boolean }): Promise<User | null> {
  if (mutation) {
    const site = request.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return null;
  }
  const current = await getRequestAuth();
  return current && current.via === 'session' ? current.user : null;
}
