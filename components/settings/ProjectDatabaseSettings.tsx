"use client";
import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface DbInfo {
  provisioned: boolean;
  status?: string;
  engine?: string;
  host?: string;
  port?: number;
  database?: string;
}

/** One-click per-project Postgres (provisioned via Coolify). */
export default function ProjectDatabaseSettings({ projectId }: { projectId: string }) {
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/database`);
      const j = await r.json();
      if (j.success) setInfo(j.data);
    } catch { /* ignore */ }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const provision = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/database`, { method: 'POST' });
      const j = await r.json();
      if (j.success) setInfo(j.data);
      else setError(j.error?.message || j.message || 'Provisioning failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Provisioning failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this project’s Postgres database? All data in it is lost.')) return;
    setBusy(true); setError(null);
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/database`, { method: 'DELETE' });
      setInfo({ provisioned: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900">Database</h3>
        <p className="text-sm text-gray-500 mt-1">A managed Postgres for this project, provisioned on your infrastructure.</p>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {!info?.provisioned ? (
        <div className="rounded-xl border border-gray-200 p-5 text-center">
          <div className="text-3xl mb-2">🗄️</div>
          <p className="text-sm text-gray-600 mb-4 max-w-sm mx-auto">
            Add a Postgres database. Its <code className="text-xs bg-gray-100 px-1 rounded">DATABASE_URL</code> is injected into the
            preview automatically — then ask the agent to add Prisma/Drizzle and build data-backed features.
          </p>
          <button
            onClick={provision}
            disabled={busy}
            className="h-9 px-4 rounded-lg bg-[#DE7356] text-white text-sm font-medium hover:bg-[#c65f43] disabled:opacity-50"
          >
            {busy ? 'Provisioning…' : 'Add Postgres database'}
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
              <span className="font-medium text-gray-900">Postgres</span>
              {info.status && <span className="text-xs text-gray-400">{info.status}</span>}
            </div>
            <button onClick={remove} disabled={busy} className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50">Remove</button>
          </div>
          <dl className="text-sm text-gray-600 grid grid-cols-[80px_1fr] gap-y-1">
            <dt className="text-gray-400">Host</dt><dd className="font-mono">{info.host}</dd>
            <dt className="text-gray-400">Port</dt><dd className="font-mono">{info.port}</dd>
            <dt className="text-gray-400">Database</dt><dd className="font-mono">{info.database}</dd>
          </dl>
          <p className="text-xs text-gray-400">
            <code className="bg-gray-100 px-1 rounded">DATABASE_URL</code> is available to the preview (and future deploys).
            The password is stored encrypted and isn&apos;t shown here.
          </p>
        </div>
      )}
    </div>
  );
}
