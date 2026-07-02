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
          <h3 className="text-lg font-semibold text-gray-900">My Account</h3>
          <div className="mt-2 text-sm text-gray-600">
            <div><span className="text-gray-400">Email:</span> {user.email}</div>
            <div><span className="text-gray-400">Role:</span> {user.role}</div>
          </div>
        </div>
        <form action={signOutAction}>
          <button
            type="submit"
            className="h-9 flex items-center gap-2 px-3 rounded-lg text-sm font-medium border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 hover:text-red-600 hover:border-red-200 transition-colors"
            title="Sign out of Claudable"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
            Sign out
          </button>
        </form>
      </div>

      <div className="rounded-xl border border-gray-200 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium text-gray-900">it-ops tools</div>
            <p className="mt-1 text-sm text-gray-500 max-w-md">
              Gives the agent real infrastructure tools (Gitea, Coolify, Traefik) in every
              project you own. AWS/IAM stays propose-only. Credentials never reach the agent.
            </p>
          </div>
          {isAdmin ? (
            <button
              type="button"
              onClick={toggleItops}
              disabled={busy}
              role="switch"
              aria-checked={itops}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                itops ? 'bg-amber-500' : 'bg-gray-300'
              }`}
              title={itops ? 'Disable it-ops tools' : 'Enable it-ops tools'}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${itops ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          ) : (
            <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${itops ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
              {itops ? 'Enabled by admin' : 'Disabled'}
            </span>
          )}
        </div>
        {!isAdmin && (
          <p className="mt-3 text-xs text-gray-400">Only an admin can enable it-ops for your account.</p>
        )}
      </div>
    </div>
  );
}
