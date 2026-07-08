"use client";
import { useState } from 'react';
import { signOutAction } from '@/app/actions/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface MyAccountSettingsProps {
  user: { id: string; email: string; role: 'admin' | 'user'; itopsEnabled?: boolean };
  onToast?: (message: string, type: 'success' | 'error') => void;
  onChanged?: () => void; // reload the current user after a change
}

/**
 * "My Account" — per-user settings. Admins can enable their own it-ops tools here
 * (the broker then attaches for every project they own). Non-admins see the state
 * read-only; an admin grants it via User Management.
 */
export default function MyAccountSettings({ user, onToast, onChanged }: MyAccountSettingsProps) {
  const [itops, setItops] = useState(!!user.itopsEnabled);
  const [busy, setBusy] = useState(false);
  const isAdmin = user.role === 'admin';

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
      onToast?.(`it-ops tools ${next ? 'enabled' : 'disabled'} for your account`, 'success');
    } catch (e) {
      onToast?.(`Failed to update it-ops: ${e instanceof Error ? e.message : 'error'}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-50">My Account</h3>
          <div className="mt-2 text-sm text-gray-600 dark:text-gray-300">
            <div><span className="text-gray-400 dark:text-gray-500">Email:</span> {user.email}</div>
            <div><span className="text-gray-400 dark:text-gray-500">Role:</span> {user.role}</div>
          </div>
        </div>
        <form action={signOutAction}>
          <button
            type="submit"
            className="h-9 flex items-center gap-2 px-3 rounded-lg text-sm font-medium border border-gray-200 dark:border-white/8 bg-white dark:bg-white/3 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6 hover:text-red-600 hover:border-red-200 transition-colors"
            title="Sign out of Claudable"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
            Sign out
          </button>
        </form>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-white/8 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="font-medium text-gray-900 dark:text-gray-50">it-ops tools</div>
          {isAdmin ? (
            <button
              type="button"
              onClick={toggleItops}
              disabled={busy}
              role="switch"
              aria-checked={itops}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                itops ? 'bg-[#DE7356]' : 'bg-gray-300'
              }`}
              title={itops ? 'Disable it-ops tools' : 'Enable it-ops tools'}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white dark:bg-gray-900 transition-transform ${itops ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          ) : (
            <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${itops ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 dark:bg-white/6 text-gray-500 dark:text-gray-400'}`}>
              {itops ? 'Enabled by admin' : 'Disabled'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
