/**
 * Theme (palette) registry. A theme re-tints the brand + neutral token ramps
 * via `data-theme` on <html> (see the [data-theme=...] blocks in
 * app/globals.css); it is orthogonal to the light/dark mode toggle, which
 * keeps working within every theme.
 *
 * Persistence mirrors the mode toggle: localStorage only, applied before
 * paint by the no-flash inline script in app/layout.tsx.
 */

import type { MessageKey } from '@/lib/i18n/messages/en';

export const PALETTE_STORAGE_KEY = 'claudable-palette';

export interface ThemeDef {
  id: string;
  /** i18n key for the display name (theme.<id> in lib/i18n/messages). */
  nameKey: MessageKey;
  /** Swatch colors for the picker UI: [brand accent, light bg, dark bg]. */
  swatch: { brand: string; light: string; dark: string };
}

export const THEMES: readonly ThemeDef[] = [
  { id: 'claudable', nameKey: 'theme.claudable', swatch: { brand: '#de7356', light: '#fafaf9', dark: '#0f0d0b' } },
  { id: 'midnight', nameKey: 'theme.midnight', swatch: { brand: '#7f6bf3', light: '#f7f8fc', dark: '#0b0d1e' } },
  { id: 'forest', nameKey: 'theme.forest', swatch: { brand: '#2f9d68', light: '#f7faf8', dark: '#0c1210' } },
  { id: 'ocean', nameKey: 'theme.ocean', swatch: { brand: '#3694e8', light: '#f6f9fc', dark: '#0a1017' } },
  { id: 'mono', nameKey: 'theme.mono', swatch: { brand: '#55555e', light: '#fafafa', dark: '#09090b' } },
] as const;

export const DEFAULT_THEME_ID = THEMES[0].id;

export function isThemeId(value: string | null | undefined): boolean {
  return !!value && THEMES.some((t) => t.id === value);
}

/** Read the persisted palette (falls back to the default). Client-only. */
export function getStoredThemeId(): string {
  try {
    const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
    return isThemeId(stored) ? (stored as string) : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/** Apply a palette to <html> and persist it. Client-only. */
export function applyTheme(id: string): void {
  const themeId = isThemeId(id) ? id : DEFAULT_THEME_ID;
  const root = document.documentElement;
  if (themeId === DEFAULT_THEME_ID) {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = themeId;
  }
  try {
    localStorage.setItem(PALETTE_STORAGE_KEY, themeId);
  } catch {
    /* private mode etc. — theme still applies for this page */
  }
}
