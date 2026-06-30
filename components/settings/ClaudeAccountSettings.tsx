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
        <h3 className="text-lg font-medium text-gray-900">Claude account</h3>
        <p className="text-sm text-gray-500">Sign in to connect your own Claude account.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-1">Claude account</h3>
        <p className="text-sm text-gray-600">
          Connect your own Claude so projects can run on your subscription. On your machine run{' '}
          <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-800 font-mono text-xs">claude setup-token</code>{' '}
          and paste the token below. Mark it shareable to let teammates pick it for a project.
        </p>
      </div>

      {/* Add form */}
      <div className="p-4 bg-gray-50 rounded-xl border border-gray-200 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. My Claude Max)"
            className="flex-1 px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-gray-200"
          />
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            placeholder="Paste token from `claude setup-token`"
            className="flex-[2] px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-200"
          />
        </div>
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={shareable} onChange={(e) => setShareable(e.target.checked)} />
            Let others in my org use this Claude
          </label>
          <button
            onClick={add}
            disabled={busy || !token.trim()}
            className="px-4 py-2 text-sm font-medium bg-gray-900 hover:bg-gray-800 text-white rounded-lg disabled:opacity-50"
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>

      {/* List */}
      <div className="rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-5 text-center text-sm text-gray-500">Loading…</div>
        ) : creds.length === 0 ? (
          <div className="p-5 text-center text-sm text-gray-400">No Claude account connected yet.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {creds.map((c) => (
              <li key={c.id} className="flex items-center gap-3 p-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{c.label}</p>
                  <p className="text-xs text-gray-500">
                    {c.lastUsedAt ? `Last used ${new Date(c.lastUsedAt).toLocaleDateString()}` : 'Never used'}
                  </p>
                </div>
                <button
                  onClick={() => toggleShare(c)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-full border ${
                    c.shareable ? 'border-green-300 text-green-700 bg-green-50' : 'border-gray-200 text-gray-600 bg-white hover:bg-gray-50'
                  }`}
                  title="Toggle sharing"
                >
                  {c.shareable ? 'Shared' : 'Private'}
                </button>
                <button
                  onClick={() => remove(c)}
                  className="px-2.5 py-1.5 text-xs font-medium border border-red-200 rounded-full bg-white text-red-600 hover:bg-red-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
