"use client";
import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Credential {
  id: string;
  label: string;
  shareable: boolean;
  isMine: boolean;
  ownerName: string | null;
  ownerEmail: string;
  lastUsedAt: string | null;
}

interface Props {
  onToast: (message: string, type: 'success' | 'error') => void;
}

export default function ClaudeAccountSettings({ onToast }: Props) {
  const [creds, setCreds] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [shareable, setShareable] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/claude-credentials`);
      if (res.status === 401) { setDenied(true); return; }
      const json = await res.json();
      if (json.success) { setCreds(json.data as Credential[]); setDenied(false); }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!token.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/claude-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), token: token.trim(), shareable }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.message || 'Failed to save');
      setLabel(''); setToken(''); setShareable(false);
      onToast('Claude account connected', 'success');
      await load();
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Failed to save', 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleShare = async (c: Credential) => {
    try {
      const res = await fetch(`${API_BASE}/api/claude-credentials/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareable: !c.shareable }),
      });
      if (!res.ok) throw new Error();
      await load();
    } catch {
      onToast('Failed to update sharing', 'error');
    }
  };

  const remove = async (c: Credential) => {
    try {
      const res = await fetch(`${API_BASE}/api/claude-credentials/${c.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      onToast(`Removed ${c.label}`, 'success');
      await load();
    } catch {
      onToast('Failed to remove', 'error');
    }
  };

  if (denied) {
    return (
      <div className="space-y-2">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50">Claude account</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">Sign in to connect your own Claude account.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50">Claude account</h3>

      {/* Add form */}
      <div className="p-4 bg-gray-50 dark:bg-white/[0.03] rounded-xl border border-gray-200 dark:border-white/[0.08] space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. My Claude Max)"
            className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.06] text-sm focus:outline-none focus:ring-2 focus:ring-gray-200"
          />
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            placeholder="Paste token from `claude setup-token`"
            className="flex-[2] px-3 py-2 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.06] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-200"
          />
        </div>
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
            <input type="checkbox" checked={shareable} onChange={(e) => setShareable(e.target.checked)} />
            Let others in my org use this Claude
          </label>
          <button
            onClick={add}
            disabled={busy || !token.trim()}
            className="px-4 py-2 text-sm font-medium bg-[#DE7356] hover:bg-[#c9634a] text-white rounded-lg disabled:opacity-50"
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>

      {/* List */}
      <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] overflow-hidden">
        {loading ? (
          <div className="p-5 text-center text-sm text-gray-500 dark:text-gray-400">Loading…</div>
        ) : creds.length === 0 ? (
          <div className="p-5 text-center text-sm text-gray-400 dark:text-gray-500">No Claude account connected yet.</div>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-white/[0.06]">
            {creds.map((c) => (
              <li key={c.id} className="flex items-center gap-3 p-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{c.label}</p>
                    {!c.isMine && (
                      <span className="shrink-0 rounded-full bg-gray-100 dark:bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:text-gray-300">
                        {c.ownerName || c.ownerEmail}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {c.lastUsedAt ? `Last used ${new Date(c.lastUsedAt).toLocaleDateString()}` : 'Never used'}
                  </p>
                </div>
                {c.isMine ? (
                  <>
                    <button
                      onClick={() => toggleShare(c)}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded-full border ${
                        c.shareable ? 'border-green-300 text-green-700 bg-green-50' : 'border-gray-200 dark:border-white/[0.08] text-gray-600 dark:text-gray-300 bg-white dark:bg-white/[0.03] hover:bg-gray-50 dark:hover:bg-white/[0.06]'
                      }`}
                      title="Toggle sharing"
                    >
                      {c.shareable ? 'Shared' : 'Private'}
                    </button>
                    <button
                      onClick={() => remove(c)}
                      className="px-2.5 py-1.5 text-xs font-medium border border-red-200 rounded-full bg-white dark:bg-white/[0.03] text-red-600 hover:bg-red-50"
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  // Another user's account — visible to admins, read-only.
                  <span
                    className={`px-2.5 py-1.5 text-xs font-medium rounded-full border ${
                      c.shareable ? 'border-green-300 text-green-700 bg-green-50' : 'border-gray-200 dark:border-white/[0.08] text-gray-500 dark:text-gray-400'
                    }`}
                  >
                    {c.shareable ? 'Shared' : 'Private'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
