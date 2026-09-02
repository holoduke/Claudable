"use client";
import { useEffect, useRef, useState } from 'react';
import GlobalSettings from '@/components/settings/GlobalSettings';
import { signOutAction } from '@/app/actions/auth';
import { useI18n } from '@/contexts/I18nContext';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

/**
 * Top-right "my user" avatar. Opens a small menu: who you are, the interface
 * language, a shortcut to the Account tab of the settings modal, and Sign out.
 */
export default function UserMenu() {
  const { t, locale, setLocale, locales } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [me, setMe] = useState<{ email?: string; name?: string | null; image?: string | null; role?: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/users/me`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setMe((j?.data as any) ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [settingsOpen]);

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  const initial = (me?.name || me?.email || '?').trim().charAt(0).toUpperCase();

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setMenuOpen((v) => !v)}
        title={t('menu.myAccount')}
        aria-label={t('menu.myAccount')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="flex items-center justify-center w-9 h-9 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700"
      >
        {me?.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={me.image} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-sm font-semibold">{initial}</span>
        )}
      </button>

      {menuOpen && (
        <div role="menu" className="absolute right-0 mt-2 w-64 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#181310] shadow-xl p-1 z-50">
          <div className="px-3 py-2">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{me?.name || me?.email || t('menu.signedIn')}</p>
            {me?.name && <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{me.email}</p>}
            {me?.role === 'admin' && <p className="text-[10px] uppercase tracking-wide text-gray-400 mt-0.5">{t('role.superadmin')}</p>}
          </div>
          <div className="border-t border-gray-100 dark:border-white/8 my-1" />
          {/* Language: the same preference as Settings → Account, one click closer. */}
          <div className="flex items-center justify-between gap-2 px-3 py-1.5">
            <span className="text-sm text-gray-800 dark:text-gray-100">{t('settings.general.language')}</span>
            <select
              aria-label={t('settings.general.language')}
              value={locale}
              onChange={(e) => setLocale(e.target.value as typeof locale)}
              className="text-sm pl-2 pr-6 py-1 rounded-lg border border-gray-200 dark:border-white/8 bg-white dark:bg-white/6 text-gray-700 dark:text-gray-200 focus:outline-hidden focus:ring-0 cursor-pointer"
            >
              {locales.map((l) => (
                <option key={l.code} value={l.code}>{l.flag} {l.label}</option>
              ))}
            </select>
          </div>
          <button
            role="menuitem"
            onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}
            className="w-full text-left px-3 py-2 text-sm rounded-lg text-gray-800 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-white/5"
          >
            {t('menu.accountSettings')}
          </button>
          <form action={signOutAction}>
            <button
              type="submit"
              role="menuitem"
              className="w-full text-left px-3 py-2 text-sm rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
            >
              {t('account.signOut')}
            </button>
          </form>
        </div>
      )}

      <GlobalSettings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} initialTab="account" />
    </div>
  );
}
