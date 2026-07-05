"use client";
import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

/** Compact "3d ago" / "just now" for the last-login line. */
function formatLastLogin(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
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
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/users`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Failed to load users');
      setUsers(json.data as ManagedUser[]);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to load users', 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => { load(); }, [load]);

  const addUser = async () => {
    const email = newEmail.trim();
    if (!email) return;
    setAdding(true);
    try {
      const res = await fetch(`${API_BASE}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: newName.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Failed to add user');
      setNewEmail('');
      setNewName('');
      const created = json.data?.created !== false;
      onToast(created ? `Invited ${email}` : `${email} is already a member`, 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to add user', 'error');
    } finally {
      setAdding(false);
    }
  };

  const patchUser = async (id: string, payload: Record<string, unknown>) => {
    setBusyId(id);
    try {
      const res = await fetch(`${API_BASE}/api/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Update failed');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Update failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const removeUser = async (id: string, email: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`${API_BASE}/api/users/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Delete failed');
      onToast(`Removed ${email}`, 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Delete failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50 mb-1">Users</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Anyone on an allowed company domain can sign in automatically. Invite external
          emails below, and promote teammates to admin.
        </p>
      </div>

      {/* Invite external user */}
      <div className="flex flex-col gap-3 p-4 bg-gray-50 dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Email</label>
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addUser(); }}
            placeholder="person@partner.com"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-200"
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Name (optional)</label>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addUser(); }}
            placeholder="Jane Doe"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-200"
          />
        </div>
        <button
          onClick={addUser}
          disabled={adding || !newEmail.trim()}
          className="px-4 py-2 text-sm font-medium bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors disabled:opacity-50"
        >
          {adding ? 'Inviting…' : 'Invite'}
        </button>
      </div>

      {/* User list */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">Loading users…</div>
        ) : users.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">No users yet.</div>
        ) : (
          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {users.map((u) => {
              const isSelf = u.id === currentUserId;
              const busy = busyId === u.id;
              return (
                <li key={u.id} className="flex items-center gap-3 p-4">
                  <div className="flex-shrink-0">
                    {u.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={u.image} alt="" className="w-9 h-9 rounded-full" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-gray-200 dark:bg-gray-800 flex items-center justify-center text-sm font-medium text-gray-600 dark:text-gray-300">
                        {(u.name || u.email).charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">
                        {u.name || u.email}
                      </p>
                      {isSelf && <span className="text-[11px] text-gray-400 dark:text-gray-500">(you)</span>}
                      {!u.isActive && (
                        <span className="text-[11px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                          deactivated
                        </span>
                      )}
                      {u.lastLoginAt === null && u.isActive && (
                        <span className="text-[11px] font-medium text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded">
                          invited
                        </span>
                      )}
                    </div>
                    {u.name && <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{u.email}</p>}
                    {u.isActive && u.lastLoginAt && (
                      <p className="text-[11px] text-gray-400 dark:text-gray-500">
                        Last login {formatLastLogin(u.lastLoginAt)}
                      </p>
                    )}
                  </div>

                  {/* Role */}
                  <select
                    value={u.role}
                    disabled={busy || isSelf}
                    onChange={(e) => patchUser(u.id, { role: e.target.value })}
                    className="px-2.5 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-700 rounded-full bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-0 disabled:opacity-50 cursor-pointer"
                    title={isSelf ? 'You cannot change your own role' : 'Change role'}
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>

                  {/* Activate / deactivate */}
                  <button
                    onClick={() => patchUser(u.id, { isActive: !u.isActive })}
                    disabled={busy || isSelf}
                    className="px-2.5 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-700 rounded-full bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
                    title={isSelf ? 'You cannot deactivate yourself' : u.isActive ? 'Deactivate' : 'Activate'}
                  >
                    {u.isActive ? 'Deactivate' : 'Activate'}
                  </button>

                  {/* it-ops tools (per-user; admins grant it to anyone) */}
                  <button
                    onClick={() => patchUser(u.id, { itopsEnabled: !u.itopsEnabled })}
                    disabled={busy}
                    className={`px-2.5 py-1.5 text-xs font-medium border rounded-full transition-colors disabled:opacity-50 ${
                      u.itopsEnabled
                        ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
                        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                    title={u.itopsEnabled ? 'Disable it-ops tools for this user' : 'Enable it-ops tools for this user'}
                  >
                    it-ops {u.itopsEnabled ? 'on' : 'off'}
                  </button>

                  {/* Remove */}
                  <button
                    onClick={() => removeUser(u.id, u.email)}
                    disabled={busy || isSelf}
                    className="px-2.5 py-1.5 text-xs font-medium border border-red-200 rounded-full bg-white dark:bg-gray-900 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40"
                    title={isSelf ? 'You cannot remove yourself' : 'Remove user'}
                  >
                    Remove
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
