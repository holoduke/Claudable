'use client';

/**
 * Translated text for the (server-rendered) login page. The page is shown
 * before sign-in, so the language comes from I18nProvider's local guess
 * (localStorage, else the browser language). That guess is read via
 * useSyncExternalStore with an English server snapshot, so the first client
 * render matches the server HTML (no hydration mismatch) and React then
 * re-renders in the browser's language.
 */
import { useT } from '@/contexts/I18nContext';
import type { MessageKey } from '@/lib/i18n/messages/en';

export default function LoginText({ k }: { k: MessageKey }) {
  const t = useT();
  return <>{t(k)}</>;
}

/** The sign-in error banner text for an Auth.js `?error=` code. */
export function LoginErrorText({ error }: { error: string }) {
  const t = useT();
  return <>{error === 'AccessDenied' ? t('login.errorAccessDenied') : t('login.errorGeneric')}</>;
}
