/**
 * Theme registry. Each theme is a COMPLETE look: it picks its own light/dark
 * mode and re-tints the brand + neutral token ramps (plus the white surface
 * tint) via `data-theme` on <html> — see the [data-theme=...] blocks in
 * app/globals.css. There is no separate mode toggle — one picker, one look.
 *
 * Persistence is localStorage only, applied before paint by the no-flash
 * inline script in app/layout.tsx (its palette→mode map must stay in sync
 * with THEMES; lib/themes.test.ts guards this).
 */

import type { MessageKey } from '@/lib/i18n/messages/en';

export const PALETTE_STORAGE_KEY = 'claudable-palette';
/** Legacy key from the old light/dark toggle; still read as a fallback. */
export const MODE_STORAGE_KEY = 'claudable-theme';

export interface ThemeDef {
  id: string;
  /** i18n key for the display name (theme.<id> in lib/i18n/messages). */
  nameKey: MessageKey;
  /** Whether this look uses the dark end of its ramp (.dark on <html>). */
  mode: 'light' | 'dark';
  /**
   * Whether a [data-theme] palette block exists in globals.css. Light and
   * Dark share the default (terracotta) ramp, so they need no block.
   */
  hasPaletteBlock: boolean;
  /** Swatch colors for the picker UI. */
  swatch: { brand: string; bg: string };
}

export const THEMES: readonly ThemeDef[] = [
  { id: 'light', nameKey: 'theme.light', mode: 'light', hasPaletteBlock: false, swatch: { brand: '#de7356', bg: '#fafaf9' } },
  { id: 'dark', nameKey: 'theme.dark', mode: 'dark', hasPaletteBlock: false, swatch: { brand: '#de7356', bg: '#0f0d0b' } },
  { id: 'midnight', nameKey: 'theme.midnight', mode: 'dark', hasPaletteBlock: true, swatch: { brand: '#8b76ff', bg: '#0d0b24' } },
  { id: 'forest', nameKey: 'theme.forest', mode: 'light', hasPaletteBlock: true, swatch: { brand: '#217a48', bg: '#eef4ed' } },
  { id: 'ocean', nameKey: 'theme.ocean', mode: 'dark', hasPaletteBlock: true, swatch: { brand: '#2196dd', bg: '#061120' } },
  { id: 'ice', nameKey: 'theme.ice', mode: 'light', hasPaletteBlock: true, swatch: { brand: '#2497c2', bg: '#f2f8fc' } },
  { id: 'cyberpunk', nameKey: 'theme.cyberpunk', mode: 'dark', hasPaletteBlock: true, swatch: { brand: '#ef2495', bg: '#120617' } },
  { id: 'neon', nameKey: 'theme.neon', mode: 'dark', hasPaletteBlock: true, swatch: { brand: '#22c73c', bg: '#07120c' } },
  { id: 'ferrari', nameKey: 'theme.ferrari', mode: 'dark', hasPaletteBlock: true, swatch: { brand: '#e11b2b', bg: '#100d0c' } },
  { id: 'party', nameKey: 'theme.party', mode: 'light', hasPaletteBlock: true, swatch: { brand: '#ec4899', bg: '#fdf2f8' } },
  { id: 'business', nameKey: 'theme.business', mode: 'light', hasPaletteBlock: true, swatch: { brand: '#2f62ae', bg: '#f8fafc' } },
  { id: 'mono', nameKey: 'theme.mono', mode: 'light', hasPaletteBlock: true, swatch: { brand: '#4a4a52', bg: '#fafafa' } },
] as const;

export const DEFAULT_THEME_ID = THEMES[0].id;

export function isThemeId(value: string | null | undefined): boolean {
  return !!value && THEMES.some((t) => t.id === value);
}

/**
 * Read the persisted theme. Falls back to the legacy light/dark preference
 * (old toggle users keep their mode), then to the OS preference. Client-only.
 */
export function getStoredThemeId(): string {
  try {
    const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
    if (isThemeId(stored)) return stored as string;
    const legacyMode = localStorage.getItem(MODE_STORAGE_KEY);
    const prefersDark = legacyMode
      ? legacyMode === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/** Apply a theme (palette + mode class) to <html> and persist it. Client-only. */
export function applyTheme(id: string): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  const root = document.documentElement;
  root.classList.toggle('dark', theme.mode === 'dark');
  if (theme.hasPaletteBlock) {
    root.dataset.theme = theme.id;
  } else {
    delete root.dataset.theme;
  }
  try {
    localStorage.setItem(PALETTE_STORAGE_KEY, theme.id);
    // Keep the legacy key in sync so anything still reading it (and the
    // fallback path above) agrees with the picked theme's mode.
    localStorage.setItem(MODE_STORAGE_KEY, theme.mode);
  } catch {
    /* private mode etc. — theme still applies for this page */
  }
}
