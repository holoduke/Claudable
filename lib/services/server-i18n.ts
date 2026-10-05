/**
 * Server-side translation for the few messages an API route has to phrase itself
 * (refusals the chat shows verbatim). Uses the same catalogs as the UI, so a
 * 'server.*' key reads identically whether the client or the server renders it.
 */
import { DATE_LOCALE, DEFAULT_LOCALE, MESSAGES, isLocale, type Locale } from '@/lib/i18n/config';
import type { en } from '@/lib/i18n/messages/en';

export type ServerMessageKey = Extract<keyof typeof en, `server.${string}`>;

export function serverT(locale: Locale, key: ServerMessageKey, vars?: Record<string, string | number>): string {
  const table = MESSAGES[locale] as Record<string, string>;
  let s = table[key] ?? (MESSAGES.en as Record<string, string>)[key] ?? key;
  for (const [k, v] of Object.entries(vars ?? {})) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** A calendar date (UTC, "5 October") in the viewer's language. */
export function formatServerDate(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(DATE_LOCALE[locale], { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/**
 * The viewer's UI language: their saved account preference, else an explicit
 * locale the client sent, else the first supported Accept-Language entry.
 */
export function resolveRequestLocale(opts: {
  userLocale?: string | null;
  bodyLocale?: unknown;
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(opts.userLocale)) return opts.userLocale;
  if (typeof opts.bodyLocale === 'string' && isLocale(opts.bodyLocale)) return opts.bodyLocale;
  for (const part of (opts.acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase().split('-')[0];
    if (isLocale(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}
