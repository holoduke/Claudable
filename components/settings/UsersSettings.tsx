"use client";
import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface ManagedUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: 'admin' | 'user';
  isActive: boolean;
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
      onToast(`Invited ${email}`, 'success');
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
        <h3 className="text-lg font-medium text-gray-900 mb-1">Users</h3>
        <p className="text-sm text-gray-600">
          Anyone on an allowed company domain can sign in automatically. Invite external
          emails below, and promote teammates to admin.
        </p>
      </div>

      {/* Invite external user */}
      <div className="flex flex-col gap-3 p-4 bg-gray-50 rounded-xl border border-gray-200 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addUser(); }}
            placeholder="person@partner.com"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-200"
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">Name (optional)</label>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addUser(); }}
            placeholder="Jane Doe"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-200"
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
      <div className="rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm text-gray-500">Loading users…</div>
        ) : users.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500">No users yet.</div>
        ) : (
          <ul className="divide-y divide-gray-200">
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
                      <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center text-sm font-medium text-gray-600">
                        {(u.name || u.email).charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {u.name || u.email}
                      </p>
                      {isSelf && <span className="text-[11px] text-gray-400">(you)</span>}
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
                    {u.name && <p className="text-xs text-gray-500 truncate">{u.email}</p>}
                  </div>

                  {/* Role */}
                  <select
                    value={u.role}
                    disabled={busy || isSelf}
                    onChange={(e) => patchUser(u.id, { role: e.target.value })}
                    className="px-2.5 py-1.5 text-xs font-medium border border-gray-200 rounded-full bg-white text-gray-700 focus:outline-none focus:ring-0 disabled:opacity-50 cursor-pointer"
                    title={isSelf ? 'You cannot change your own role' : 'Change role'}
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>

                  {/* Activate / deactivate */}
                  <button
                    onClick={() => patchUser(u.id, { isActive: !u.isActive })}
                    disabled={busy || isSelf}
                    className="px-2.5 py-1.5 text-xs font-medium border border-gray-200 rounded-full bg-white text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
                    title={isSelf ? 'You cannot deactivate yourself' : u.isActive ? 'Deactivate' : 'Activate'}
                  >
                    {u.isActive ? 'Deactivate' : 'Activate'}
                  </button>

                  {/* Remove */}
                  <button
                    onClick={() => removeUser(u.id, u.email)}
                    disabled={busy || isSelf}
                    className="px-2.5 py-1.5 text-xs font-medium border border-red-200 rounded-full bg-white text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40"
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
