/**
 * i18n locale registry. Four languages, all reviewed by the team: English is
 * the source of truth + fallback (see the t() in I18nContext), Dutch is the
 * portal's primary audience, German and French cover the rest of the market.
 */
import { en } from './messages/en';
import { nl } from './messages/nl';
import { de } from './messages/de';
import { fr } from './messages/fr';

export const MESSAGES = { en, nl, de, fr };

export type Locale = keyof typeof MESSAGES;

export const DEFAULT_LOCALE: Locale = 'en';

/** Ordered list shown in the language switcher. */
export const LOCALES: { code: Locale; label: string; flag: string }[] = [
  { code: 'nl', label: 'Nederlands', flag: '🇳🇱' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
];

/** BCP-47 tags for Intl date/number formatting per UI language. */
export const DATE_LOCALE: Record<Locale, string> = { en: 'en-GB', nl: 'nl-NL', de: 'de-DE', fr: 'fr-FR' };

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && value in MESSAGES;
}
