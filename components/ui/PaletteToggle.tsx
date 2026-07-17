"use client";
import { useEffect, useState } from 'react';
import { THEMES, DEFAULT_THEME_ID, getStoredThemeId, applyTheme } from '@/lib/themes';
import { useT } from '@/contexts/I18nContext';

/** The theme button: a direct toggle that cycles through all themes on click
 *  (no menu). Shows the active theme's swatch; the tooltip names the current
 *  and next theme. Persists via localStorage('claudable-palette'); the
 *  no-flash init in layout applies the same key before paint. */
export default function PaletteToggle({ className = '' }: { className?: string }) {
  const t = useT();
  const [active, setActive] = useState(DEFAULT_THEME_ID);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setActive(getStoredThemeId());
  }, []);

  const activeIndex = Math.max(0, THEMES.findIndex((theme) => theme.id === active));
  const activeTheme = THEMES[activeIndex];
  const nextTheme = THEMES[(activeIndex + 1) % THEMES.length];

  const cycle = () => {
    applyTheme(nextTheme.id);
    setActive(nextTheme.id);
  };

  const label = `${t('theme.pick')}: ${t(activeTheme.nameKey)} → ${t(nextTheme.nameKey)}`;

  return (
    <button
      onClick={cycle}
      title={mounted ? label : t('theme.pick')}
      aria-label={mounted ? label : t('theme.pick')}
      className={`h-9 w-9 flex items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors ${className}`}
    >
      {/* Active theme as a swatch (surface + accent dot). */}
      {mounted ? (
        <span
          className="relative h-5 w-5 rounded-full border border-gray-300 dark:border-white/20 overflow-hidden"
          style={{ backgroundColor: activeTheme.swatch.bg }}
          aria-hidden
        >
          <span
            className="absolute inset-0 m-auto h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: activeTheme.swatch.brand }}
          />
        </span>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 22a10 10 0 1 1 10-10c0 2.5-2 3-3.5 3H16a2 2 0 0 0-1 3.75A1.3 1.3 0 0 1 12 22Z" />
        </svg>
      )}
    </button>
  );
}
