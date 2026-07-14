/**
 * i18n locale registry. Static catalogs (small, 8 langs) are bundled directly.
 * English is the source of truth + fallback (see the t() in I18nContext).
 */
import { en } from './messages/en';
import { nl } from './messages/nl';
import { de } from './messages/de';
import { fr } from './messages/fr';
import { es } from './messages/es';
import { it } from './messages/it';
import { pt } from './messages/pt';
import { ja } from './messages/ja';

export const MESSAGES = { en, nl, de, fr, es, it, pt, ja };

export type Locale = keyof typeof MESSAGES;

export const DEFAULT_LOCALE: Locale = 'en';

/** Ordered list shown in the language switcher. */
export const LOCALES: { code: Locale; label: string; flag: string }[] = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'nl', label: 'Nederlands', flag: '🇳🇱' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'it', label: 'Italiano', flag: '🇮🇹' },
  { code: 'pt', label: 'Português', flag: '🇵🇹' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
];

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && value in MESSAGES;
}
