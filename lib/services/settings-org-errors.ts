/**
 * Map an OrgError (lib/services/orgs.ts) to its API response: the stable
 * `code` in `error`, an English `message`, and the error's HTTP status. The UI
 * translates the code (settings.errors.*) and falls back to the message.
 * Returns null for anything that is not an OrgError so the caller can fall
 * through to handleApiError.
 */
import { createErrorResponse } from '@/lib/utils/api-response';
import { isOrgError, toOrgError } from '@/lib/services/orgs';

export function orgErrorResponse(error: unknown): Response | null {
  const e = toOrgError(error);
  return isOrgError(e) ? createErrorResponse(e.code, e.message, e.status) : null;
}
