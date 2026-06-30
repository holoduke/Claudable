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
  // it-ops toggle: null = not an admin (section hidden); boolean = admin
  const [itops, setItops] = useState<boolean | null>(null);
  const [itopsBusy, setItopsBusy] = useState(false);

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

  // Admin-only it-ops toggle: the GET 403s for non-admins, so the section stays hidden.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/projects/${projectId}/itops`)
      .then(async (r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j?.success) setItops(!!j.data.enabled); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  const toggleItops = async () => {
    if (itops === null) return;
    setItopsBusy(true);
    const next = !itops;
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/itops`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (res.ok) setItops(next);
    } catch {
      /* keep previous */
    } finally {
      setItopsBusy(false);
    }
  };

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

  if (loading) return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  if (denied) {
    return (
      <div className="p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-1">Claude account</h3>
        <p className="text-sm text-gray-500">{denied}</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-1">Claude account</h3>
        <p className="text-sm text-gray-600">
          Which Claude account this project&apos;s agent runs use. Pick a connected account (yours, or one a
          teammate shared) or use the platform default.
        </p>
      </div>

      <select
        value={credentialId ?? '__default__'}
        onChange={(e) => choose(e.target.value)}
        disabled={busy}
        className="w-full max-w-md px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-200 disabled:opacity-50"
      >
        <option value="__default__">Platform default (shared Claude)</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label} — {o.isMine ? 'you' : (o.ownerName || o.ownerEmail)}
          </option>
        ))}
      </select>

      {options.length === 0 && (
        <p className="text-xs text-gray-400">
          No connected accounts yet. Connect one under Global Settings → Claude, or ask a teammate to share theirs.
        </p>
      )}

      {itops !== null && (
        <div className="mt-6 pt-5 border-t border-gray-200">
          <div className="flex items-center justify-between gap-4">
            <div className="pr-2">
              <p className="font-medium text-gray-900">it-ops tools <span className="text-xs font-normal text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">admin</span></p>
              <p className="text-sm text-gray-600">
                Give this project&apos;s agent the shared it-ops tools (infra health, deploy targets, and proposing
                infra changes for review). Read-only / propose-only — it never gets credentials or applies changes directly.
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
              <input type="checkbox" className="sr-only peer" checked={itops} disabled={itopsBusy} onChange={toggleItops} />
              <div className="w-11 h-6 bg-gray-200 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-600" />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
