"use client";
import { useCallback, useEffect, useRef, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Member { id: string; email: string; name: string | null; image: string | null }
interface AccessState { visibility: 'org' | 'restricted'; members: Member[] }

interface Props { projectId: string }

export default function ProjectAccessSettings({ projectId }: Props) {
  const [access, setAccess] = useState<AccessState | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Autocomplete state
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Member[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setDenied(null);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/access`);
      const json = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        setDenied(json.message || 'You do not have permission to manage this project.');
        return;
      }
      if (!res.ok || !json.success) throw new Error(json.message || 'Failed to load access');
      setAccess(json.data as AccessState);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load access');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // Close the dropdown on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Debounced org-user search.
  useEffect(() => {
    if (access?.visibility !== 'restricted') return;
    const q = query.trim();
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/users/search?q=${encodeURIComponent(q)}`);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        const memberIds = new Set((access?.members ?? []).map((m) => m.id));
        setResults(((json.data as Member[]) ?? []).filter((u) => !memberIds.has(u.id)));
        setOpen(true);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, access?.visibility, access?.members]);

  const setVisibility = async (visibility: 'org' | 'restricted') => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.message || 'Failed to update');
      setAccess(json.data as AccessState);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    } finally {
      setBusy(false);
    }
  };

  const addMember = async (userId: string) => {
    setBusy(true);
    setError(null);
    setQuery('');
    setResults([]);
    setOpen(false);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.message || 'Failed to add');
      setAccess(json.data as AccessState);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add');
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (userId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/members/${userId}`, {
        method: 'DELETE',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.message || 'Failed to remove');
      setAccess(json.data as AccessState);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">Loading access settings…</div>;
  }
  if (denied) {
    return (
      <div className="p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-1">Access</h3>
        <p className="text-sm text-gray-500">{denied}</p>
      </div>
    );
  }

  const restricted = access?.visibility === 'restricted';
  const avatar = (m: Member) =>
    m.image ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={m.image} alt="" className="w-7 h-7 rounded-full" />
    ) : (
      <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium text-gray-600">
        {(m.name || m.email).charAt(0).toUpperCase()}
      </div>
    );

  return (
    <div className="p-6 space-y-5">
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-1">Access</h3>
        <p className="text-sm text-gray-600">Control who in your organization can see and open this project.</p>
      </div>

      {/* Toggle */}
      <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="pr-4">
          <p className="font-medium text-gray-900">Restrict to specific users</p>
          <p className="text-sm text-gray-600">
            {restricted
              ? 'Only the people you assign below (plus the owner and admins) can access this project.'
              : 'Currently open to everyone in your organization.'}
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={restricted}
            disabled={busy}
            onChange={(e) => setVisibility(e.target.checked ? 'restricted' : 'org')}
          />
          <div className="w-11 h-6 bg-gray-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
        </label>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {restricted && (
        <>
          {/* Autocomplete search */}
          <div ref={boxRef} className="relative">
            <label className="block text-xs font-medium text-gray-600 mb-1">Add people</label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => { if (results.length) setOpen(true); }}
              placeholder="Search by name or email…"
              className="w-full px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
            {open && (
              <div className="absolute z-10 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg max-h-60 overflow-y-auto">
                {searching ? (
                  <div className="px-3 py-2 text-sm text-gray-400">Searching…</div>
                ) : results.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-gray-400">No matching users</div>
                ) : (
                  results.map((u) => (
                    <button
                      key={u.id}
                      onClick={() => addMember(u.id)}
                      disabled={busy}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-gray-50 disabled:opacity-50"
                    >
                      {avatar(u)}
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-900 truncate">{u.name || u.email}</span>
                        {u.name && <span className="block text-xs text-gray-500 truncate">{u.email}</span>}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Assigned members */}
          <div>
            <p className="text-xs font-medium text-gray-600 mb-2">
              Assigned ({access?.members.length ?? 0})
            </p>
            {(access?.members.length ?? 0) === 0 ? (
              <p className="text-sm text-gray-400">No one assigned yet — search above to add people.</p>
            ) : (
              <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200">
                {access!.members.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                    {avatar(m)}
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-gray-900 truncate">{m.name || m.email}</span>
                      {m.name && <span className="block text-xs text-gray-500 truncate">{m.email}</span>}
                    </span>
                    <button
                      onClick={() => removeMember(m.id)}
                      disabled={busy}
                      className="px-2.5 py-1 text-xs font-medium border border-gray-200 rounded-full bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
