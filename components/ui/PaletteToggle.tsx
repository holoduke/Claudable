"use client";
import { useEffect, useRef, useState } from 'react';
import { THEMES, DEFAULT_THEME_ID, getStoredThemeId, applyTheme } from '@/lib/themes';
import { useT } from '@/contexts/I18nContext';

/** Theme (palette) picker. Sits next to the light/dark ThemeToggle: a palette
 *  button opening a small popover with the five color themes. Persists via
 *  localStorage('claudable-palette'); the no-flash init in layout applies the
 *  same key before paint. */
export default function PaletteToggle({ className = '' }: { className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(DEFAULT_THEME_ID);
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    setActive(getStoredThemeId());
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (id: string) => {
    applyTheme(id);
    setActive(id);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={t('theme.pick')}
        aria-label={t('theme.pick')}
        aria-haspopup="menu"
        aria-expanded={open}
        className="h-9 w-9 flex items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
      >
        {/* Palette icon */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22a10 10 0 1 1 10-10c0 2.5-2 3-3.5 3H16a2 2 0 0 0-1 3.75A1.3 1.3 0 0 1 12 22Z" />
          <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
          <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
          <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
          <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
        </svg>
      </button>

      {mounted && open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-50 w-44 rounded-xl border border-gray-200 dark:border-white/9 bg-white dark:bg-gray-900 shadow-xl p-1.5"
        >
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              role="menuitemradio"
              aria-checked={active === theme.id}
              onClick={() => pick(theme.id)}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors ${
                active === theme.id
                  ? 'bg-gray-100 dark:bg-white/8 text-gray-900 dark:text-gray-50'
                  : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5'
              }`}
            >
              {/* Swatch: brand dot bridging the theme's light/dark surfaces. */}
              <span
                className="relative h-5 w-5 shrink-0 rounded-full border border-gray-200 dark:border-white/12 overflow-hidden"
                style={{ background: `linear-gradient(135deg, ${theme.swatch.light} 50%, ${theme.swatch.dark} 50%)` }}
                aria-hidden
              >
                <span
                  className="absolute inset-0 m-auto h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: theme.swatch.brand }}
                />
              </span>
              <span className="flex-1 text-left">{t(theme.nameKey)}</span>
              {active === theme.id && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
