"use client";
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/contexts/I18nContext';
import { translateApiError } from './settings-errors';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

type TFunc = ReturnType<typeof useI18n>['t'];

/** Compact "3d ago" / "just now" for the last-login line. */
function formatLastLogin(iso: string, t: TFunc): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return t('settings.users.justNow');
  if (s < 3600) return t('settings.users.minutesAgo', { count: Math.floor(s / 60) });
  if (s < 86400) return t('settings.users.hoursAgo', { count: Math.floor(s / 3600) });
  if (s < 2592000) return t('settings.users.daysAgo', { count: Math.floor(s / 86400) });
  return new Date(iso).toLocaleDateString();
}

interface ManagedUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: 'admin' | 'user';
  isActive: boolean;
  itopsEnabled?: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

interface UsersSettingsProps {
  /** id of the signed-in admin — used to disable self-mutating controls */
  currentUserId: string;
  onToast: (message: string, type: 'success' | 'error') => void;
}

export default function UsersSettings({ currentUserId, onToast }: UsersSettingsProps) {
  const { t } = useI18n();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/users`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(translateApiError(json, t, t('settings.users.loadFailed')));
      setUsers(json.data as ManagedUser[]);
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('settings.users.loadFailed'), 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast, t]);

  useEffect(() => { load(); }, [load]);


  const patchUser = async (id: string, payload: Record<string, unknown>) => {
    setBusyId(id);
    try {
      const res = await fetch(`${API_BASE}/api/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(translateApiError(json, t, t('settings.users.updateFailed')));
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('settings.users.updateFailed'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const removeUser = async (u: ManagedUser) => {
    // Permanent and irreversible — same explicit confirmation as removing an org member.
    if (!window.confirm(t('settings.users.confirmRemove', { name: u.name || u.email }))) return;
    setBusyId(u.id);
    try {
      const res = await fetch(`${API_BASE}/api/users/${u.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || !json.success) {
        // last_owner: deleting would leave an organisation without an owner.
        const msg = json?.error === 'last_owner'
          ? t('settings.users.lastOwner', { name: u.name || u.email })
          : translateApiError(json, t, t('settings.users.deleteFailed'));
        throw new Error(msg);
      }
      onToast(t('settings.users.removed', { email: u.email }), 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('settings.users.deleteFailed'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50">{t('settings.users.title')}</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('users.intro')}</p>
      </div>

      {/* User list */}
      <div className="rounded-xl border border-gray-200 dark:border-white/8 overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">{t('settings.users.loading')}</div>
        ) : users.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">{t('settings.users.empty')}</div>
        ) : (
          <ul className="divide-y divide-gray-200 dark:divide-white/8">
            {users.map((u) => {
              const isSelf = u.id === currentUserId;
              const busy = busyId === u.id;
              return (
                <li key={u.id} className="flex items-center gap-3 p-4">
                  <div className="shrink-0">
                    {u.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={u.image} alt="" className="w-9 h-9 rounded-full" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-gray-200 dark:bg-white/6 flex items-center justify-center text-sm font-medium text-gray-600 dark:text-gray-300">
                        {(u.name || u.email).charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">
                        {u.name || u.email}
                      </p>
                      {isSelf && <span className="text-[11px] text-gray-400 dark:text-gray-500">{t('common.you')}</span>}
                      {!u.isActive && (
                        <span className="text-[11px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-sm">
                          {t('common.deactivated')}
                        </span>
                      )}
                      {u.lastLoginAt === null && u.isActive && (
                        <span className="text-[11px] font-medium text-brand-500 bg-brand-500/10 px-1.5 py-0.5 rounded-sm">
                          {t('settings.users.invited')}
                        </span>
                      )}
                    </div>
                    {u.name && <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{u.email}</p>}
                    {u.isActive && u.lastLoginAt && (
                      <p className="text-[11px] text-gray-400 dark:text-gray-500">
                        {t('settings.users.lastLogin', { when: formatLastLogin(u.lastLoginAt, t) })}
                      </p>
                    )}
                  </div>

                  {/* Role */}
                  <select
                    value={u.role}
                    disabled={busy || isSelf}
                    onChange={(e) => patchUser(u.id, { role: e.target.value })}
                    className="px-2.5 py-1.5 text-xs font-medium border border-gray-200 dark:border-white/8 rounded-full bg-white dark:bg-white/6 text-gray-700 dark:text-gray-200 focus:outline-hidden focus:ring-0 disabled:opacity-50 cursor-pointer"
                    title={isSelf ? t('settings.users.cannotChangeOwnRole') : t('settings.users.changeRole')}
                    aria-label={t('settings.users.changeRole')}
                  >
                    {/* 'admin' is de opgeslagen waarde; getoond als "Superadmin":
                        instantie-breed beheer (alle organisaties, alle projecten),
                        niet te verwarren met org-rollen (eigenaar/beheerder/lid). */}
                    <option value="user">{t('role.user')}</option>
                    <option value="admin">{t('role.superadmin')}</option>
                  </select>

                  {/* Activate / deactivate */}
                  <button
                    onClick={() => patchUser(u.id, { isActive: !u.isActive })}
                    disabled={busy || isSelf}
                    className="px-2.5 py-1.5 text-xs font-medium border border-gray-200 dark:border-white/8 rounded-full bg-white dark:bg-white/3 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6 transition-colors disabled:opacity-50"
                    title={isSelf ? t('settings.users.cannotDeactivateSelf') : u.isActive ? t('settings.users.deactivate') : t('settings.users.activate')}
                  >
                    {u.isActive ? t('settings.users.deactivate') : t('settings.users.activate')}
                  </button>

                  {/* it-ops tools (per-user; admins grant it to anyone) */}
                  <button
                    onClick={() => patchUser(u.id, { itopsEnabled: !u.itopsEnabled })}
                    disabled={busy}
                    className={`px-2.5 py-1.5 text-xs font-medium border rounded-full transition-colors disabled:opacity-50 ${
                      u.itopsEnabled
                        ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
                        : 'border-gray-200 dark:border-white/8 bg-white dark:bg-white/3 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6'
                    }`}
                    title={u.itopsEnabled ? t('settings.users.itopsDisableTitle') : t('settings.users.itopsEnableTitle')}
                  >
                    {u.itopsEnabled ? t('settings.users.itopsOn') : t('settings.users.itopsOff')}
                  </button>

                  {/* Remove */}
                  <button
                    onClick={() => removeUser(u)}
                    disabled={busy || isSelf}
                    className="px-2.5 py-1.5 text-xs font-medium border border-red-200 rounded-full bg-white dark:bg-white/3 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40"
                    title={isSelf ? t('settings.users.cannotRemoveSelf') : t('settings.users.removeTitle')}
                  >
                    {t('common.remove')}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
