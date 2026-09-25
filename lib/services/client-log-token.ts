/**
 * Per-project token for the preview console-log endpoint.
 *
 * /api/projects/:id/client-logs is called by the injected preview plugin without
 * a session (the preview is another origin). Its entries reach that project's
 * agent, so an unauthenticated writer could prompt-inject any project whose id it
 * learns (preview hostnames are public). The plugin therefore carries an HMAC of
 * the project id: a project can read its own token, never compute another's.
 */
import { createHmac, timingSafeEqual } from 'crypto';

function secret(): string {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.ENCRYPTION_KEY || '';
}

export function clientLogToken(projectId: string): string {
  return createHmac('sha256', secret()).update(`client-logs:${projectId}`).digest('base64url').slice(0, 32);
}

export function isValidClientLogToken(projectId: string, token: string | null | undefined): boolean {
  if (!token || !secret()) return false;
  const expected = Buffer.from(clientLogToken(projectId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
