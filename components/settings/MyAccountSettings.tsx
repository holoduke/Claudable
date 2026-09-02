"use client";
import { useEffect, useState } from 'react';
import { signOutAction } from '@/app/actions/auth';
import { useI18n } from '@/contexts/I18nContext';
import type { MyOrg } from './MyOrgSettings';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface MyAccountSettingsProps {
  user: { id: string; email: string; name?: string | null; image?: string | null; role: 'admin' | 'user'; itopsEnabled?: boolean };
  onToast?: (message: string, type: 'success' | 'error') => void;
  onChanged?: () => void; // reload the current user after a change
}

/**
 * "Account" — everything that is about YOU: who you are signed in as, which
 * organisations you belong to (and as what), your interface language, the
 * it-ops toggle (admins), and sign out.
 */
export default function MyAccountSettings({ user, onToast, onChanged }: MyAccountSettingsProps) {
  const { locale, setLocale, locales, t } = useI18n();
  const [itops, setItops] = useState(!!user.itopsEnabled);
  const [busy, setBusy] = useState(false);
  const [orgs, setOrgs] = useState<MyOrg[] | null>(null);
  const isAdmin = user.role === 'admin';
  const count = (n: number, kind: 'members' | 'projects') => (n === 1 ? t(`common.${kind}.one`) : t(`common.${kind}.other`, { count: n }));

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/orgs/mine`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setOrgs(j?.success ? ((j.data?.orgs as MyOrg[]) ?? []) : []); })
      .catch(() => { if (!cancelled) setOrgs([]); });
    return () => { cancelled = true; };
  }, []);

  const toggleItops = async () => {
    if (!isAdmin || busy) return;
    const next = !itops;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/users/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itopsEnabled: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error?.message || j?.message || `HTTP ${res.status}`);
      }
      setItops(next);
      onChanged?.();
      onToast?.(next ? t('account.itops.toastOn') : t('account.itops.toastOff'), 'success');
    } catch (e) {
      onToast?.(t('account.itops.failed', { error: e instanceof Error ? e.message : 'error' }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const initial = (user.name || user.email).trim().charAt(0).toUpperCase();

  return (
    <div className="space-y-6">
      {/* Identity */}
      <div className="flex items-center gap-4">
        {user.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.image} alt="" className="w-14 h-14 rounded-full ring-1 ring-gray-200 dark:ring-white/10" />
        ) : (
          <div className="w-14 h-14 rounded-full bg-gray-200 dark:bg-white/8 flex items-center justify-center text-xl font-semibold text-gray-600 dark:text-gray-300">
            {initial}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-50 truncate">{user.name || user.email}</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{user.email}</p>
          <p className="mt-1">
            <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-sm ${isAdmin ? 'text-amber-800 bg-amber-100 dark:text-amber-200 dark:bg-amber-500/20' : 'text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-white/8'}`}>
              {isAdmin ? t('role.superadmin') : t('role.user')}
            </span>
          </p>
        </div>
        <form action={signOutAction}>
          <button
            type="submit"
            className="h-9 flex items-center gap-2 px-3 rounded-lg text-sm font-medium border border-gray-200 dark:border-white/8 bg-white dark:bg-white/3 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6 hover:text-red-600 hover:border-red-200 transition-colors"
            title={t('account.signOutTitle')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
            {t('account.signOut')}
          </button>
        </form>
      </div>

      {/* Organisations */}
      <section className="rounded-xl border border-gray-200 dark:border-white/8 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 dark:bg-white/3 border-b border-gray-200 dark:border-white/8">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-50">{t('account.orgs.title')}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('account.orgs.desc')}{isAdmin ? ` ${t('account.orgs.superadminNote')}` : ''}</p>
        </div>
        {orgs === null ? (
          <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>
        ) : orgs.length === 0 ? (
          <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{t('org.noneYet')}</p>
        ) : (
          <ul className="divide-y divide-gray-200 dark:divide-white/8">
            {orgs.map((o) => (
              <li key={o.id} className="flex items-center gap-3 px-4 py-3">
                <div className="w-8 h-8 rounded-lg bg-gray-200 dark:bg-white/6 flex items-center justify-center text-sm font-semibold text-gray-600 dark:text-gray-300 shrink-0">
                  {o.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{o.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {o.type === 'klant' ? t('orgType.klant') : t('orgType.intern')} · {count(o.memberCount, 'members')} · {count(o.projectCount, 'projects')}
                  </p>
                </div>
                <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-white/8 px-2 py-0.5 rounded-full">{t(`role.${o.role}` as 'role.lid')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Preferences */}
      <section className="rounded-xl border border-gray-200 dark:border-white/8 divide-y divide-gray-200 dark:divide-white/8">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-50">{t('settings.general.language')}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('settings.general.languageDesc')}</p>
          </div>
          <select
            value={locale}
            onChange={(e) => setLocale(e.target.value as typeof locale)}
            className="shrink-0 pl-3 pr-8 py-2 text-sm border border-gray-200 dark:border-white/8 rounded-lg bg-white dark:bg-white/6 hover:border-gray-300 dark:hover:border-white/18 text-gray-700 dark:text-gray-200 focus:outline-hidden focus:ring-0 transition-colors cursor-pointer"
          >
            {locales.map((l) => (
              <option key={l.code} value={l.code}>{l.flag} {l.label}</option>
            ))}
          </select>
        </div>

        {(isAdmin || itops) && (
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-50">{t('account.itops.title')}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{isAdmin ? t('account.itops.descAdmin') : t('account.itops.descUser')}</p>
            </div>
            {isAdmin ? (
              <button
                type="button"
                onClick={toggleItops}
                disabled={busy}
                role="switch"
                aria-checked={itops}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${itops ? 'bg-brand-500' : 'bg-gray-300'}`}
                title={itops ? t('account.itops.turnOff') : t('account.itops.turnOn')}
              >
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white dark:bg-gray-900 transition-transform ${itops ? 'translate-x-5' : 'translate-x-1'}`} />
              </button>
            ) : (
              <span className="shrink-0 rounded-full px-3 py-1 text-xs font-medium bg-amber-100 text-amber-700">{t('account.itops.enabled')}</span>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
