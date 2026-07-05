"use client";
import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Option {
  id: string;
  label: string;
  ownerName: string | null;
  ownerEmail: string;
  isMine: boolean;
}

interface Props {
  projectId: string;
}

export default function ProjectClaudeSettings({ projectId }: Props) {
  const [options, setOptions] = useState<Option[]>([]);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/claude-credential`);
      const json = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        setDenied(json.message || 'Only the project owner or an admin can change this.');
        return;
      }
      if (json.success) {
        setOptions(json.data.options as Option[]);
        setCredentialId(json.data.credentialId ?? null);
        setDenied(null);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const choose = async (value: string) => {
    const credId = value === '__default__' ? null : value;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/claude-credential`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialId: credId }),
      });
      if (!res.ok) throw new Error();
      setCredentialId(credId);
    } catch {
      /* keep previous */
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading…</div>;
  if (denied) {
    return (
      <div className="p-6">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50 mb-1">Claude account</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">{denied}</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50">Claude account</h3>

      <select
        value={credentialId ?? '__default__'}
        onChange={(e) => choose(e.target.value)}
        disabled={busy}
        className="w-full max-w-md px-3 py-2 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.06] text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-200 disabled:opacity-50"
      >
        <option value="__default__">Platform default (shared Claude)</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label} — {o.isMine ? 'you' : (o.ownerName || o.ownerEmail)}
          </option>
        ))}
      </select>

      {options.length === 0 && (
        <p className="text-xs text-gray-400 dark:text-gray-500">
          No connected accounts yet. Connect one under Global Settings → Claude, or ask a teammate to share theirs.
        </p>
      )}

    </div>
  );
}
