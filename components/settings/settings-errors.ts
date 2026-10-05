/**
 * Translate an API error body by its stable machine code (`error`), falling
 * back to the server's message and then to `fallback`. Org/user management
 * routes return codes such as `last_owner` or `org_domain_exists`
 * (lib/services/orgs.ts OrgError) next to an English message.
 */
import type { MessageKey } from '@/lib/i18n/messages/en';
import { apiErrorMessage } from '@/lib/client/api-error';

type TFunc = (key: MessageKey, vars?: Record<string, string | number>) => string;

const CODE_KEYS: Record<string, MessageKey> = {
  org_name_required: 'settings.errors.org_name_required',
  org_invalid_type: 'settings.errors.org_invalid_type',
  org_invalid_domain: 'settings.errors.org_invalid_domain',
  org_domain_exists: 'settings.errors.org_domain_exists',
  org_not_found: 'settings.errors.org_not_found',
  org_has_projects: 'settings.errors.org_has_projects',
  org_has_members: 'settings.errors.org_has_members',
  invalid_role: 'settings.errors.invalid_role',
  invalid_email: 'settings.errors.invalid_email',
  already_member: 'settings.errors.already_member',
  owner_required: 'settings.errors.owner_required',
  invite_not_found: 'settings.errors.invite_not_found',
  invite_already_accepted: 'settings.errors.invite_already_accepted',
  membership_not_found: 'settings.errors.membership_not_found',
  last_owner: 'settings.errors.last_owner',
  // Emitted by app/api/users/[id] (PATCH/DELETE), not by the org service.
  last_admin: 'settings.errors.last_admin',
};

/** The machine code of an error body, if any. */
export function apiErrorCode(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const code = (json as Record<string, unknown>).error;
  return typeof code === 'string' ? code : null;
}

export function translateApiError(json: unknown, t: TFunc, fallback: string): string {
  const code = apiErrorCode(json);
  const key = code ? CODE_KEYS[code] : undefined;
  return key ? t(key) : apiErrorMessage(json, fallback);
}
