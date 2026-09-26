/**
 * Danger zone: completely wipe this project (Project settings → General).
 * Shows the server's wipe plan first; the wipe needs the exact project name typed.
 */
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface WipePlan {
  project: { id: string; name: string };
  paths: string[];
  containers: string[];
  network: string | null;
  routeFiles: string[];
  managedServices: { container: string; volume: string }[];
  database: { uuid: string; name?: string; deletable: boolean; reason?: string } | null;
  remoteRepo: { owner: string; repo: string; url?: string; deletable: boolean; reason?: string } | null;
  skipped: { what: string; reason: string }[];
  blockers: string[];
}

interface WipeResult {
  removed: string[];
  failed: { what: string; error: string }[];
  skipped: { what: string; reason: string }[];
}

export function ProjectWipeSection({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [plan, setPlan] = useState<WipePlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [deleteDatabase, setDeleteDatabase] = useState(false);
  const [deleteRemoteRepo, setDeleteRemoteRepo] = useState(false);
  const [result, setResult] = useState<WipeResult | null>(null);

  const loadPlan = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/wipe`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) throw new Error(json?.message || json?.error || 'Could not load what would be deleted.');
      setPlan(json.data as WipePlan);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load what would be deleted.');
    } finally {
      setLoading(false);
    }
  };

  const wipe = async () => {
    if (!plan || confirm !== plan.project.name) return;
    setWiping(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/wipe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName: confirm, deleteDatabase, deleteRemoteRepo }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) throw new Error(json?.message || json?.error || 'Wipe failed.');
      setResult(json.data as WipeResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Wipe failed.');
    } finally {
      setWiping(false);
    }
  };

  if (result) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-500/30 p-4 space-y-3">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-50">Project wiped</h4>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Removed {result.removed.length} item(s).
          {result.failed.length > 0 && ` ${result.failed.length} item(s) could not be removed:`}
        </p>
        {result.failed.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-red-700 dark:text-red-400">
            {result.failed.map((f) => <li key={f.what}>{f.what}: {f.error}</li>)}
          </ul>
        )}
        <button
          onClick={() => router.push('/')}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm text-white hover:bg-brand-600"
        >
          Back to projects
        </button>
      </div>
    );
  }

  const count = plan
    ? plan.paths.length + plan.containers.length + plan.routeFiles.length + plan.managedServices.length + (plan.network ? 1 : 0)
    : 0;

  return (
    <div className="rounded-lg border border-red-200 dark:border-red-500/30 p-4 space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-red-700 dark:text-red-400">Danger zone</h4>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          Completely wipe this project: its files, chat history, checkpoints, preview and containers. This cannot be undone.
          Other projects are never affected.
        </p>
      </div>

      {!plan && (
        <button
          onClick={loadPlan}
          disabled={loading}
          className="rounded-lg border border-red-300 dark:border-red-500/40 px-4 py-2 text-sm font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-50"
        >
          {loading ? 'Checking…' : 'Wipe project…'}
        </button>
      )}

      {plan && (
        <div className="space-y-4">
          <div className="text-sm text-gray-700 dark:text-gray-200">
            <p className="font-medium">This removes:</p>
            <ul className="mt-1 list-disc pl-5 space-y-0.5 text-gray-600 dark:text-gray-300">
              <li>the project record with all chats, sessions, env vars, members, share links and comments</li>
              {plan.paths.length > 0 && <li>{plan.paths.length} folder(s)/file(s): project files, agent history, checkpoints, thumbnail, design scratch</li>}
              {(plan.containers.length + plan.managedServices.length) > 0 && (
                <li>preview, agent and service containers{plan.managedServices.length > 0 ? ' incl. their data volumes' : ''}</li>
              )}
              {plan.network && <li>its private network and preview address</li>}
            </ul>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{count} local item(s) in total.</p>
          </div>

          {plan.database && (
            <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={deleteDatabase}
                disabled={!plan.database.deletable}
                onChange={(e) => setDeleteDatabase(e.target.checked)}
              />
              <span>
                Also delete the external database{plan.database.name ? ` (${plan.database.name})` : ''} and all its data
                {!plan.database.deletable && <span className="block text-xs text-gray-500">Not possible: {plan.database.reason}</span>}
              </span>
            </label>
          )}

          {plan.remoteRepo && (
            <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={deleteRemoteRepo}
                disabled={!plan.remoteRepo.deletable}
                onChange={(e) => setDeleteRemoteRepo(e.target.checked)}
              />
              <span>
                Also delete the git repository {plan.remoteRepo.owner}/{plan.remoteRepo.repo}
                {!plan.remoteRepo.deletable && <span className="block text-xs text-gray-500">Not possible: {plan.remoteRepo.reason}</span>}
              </span>
            </label>
          )}

          {plan.skipped.length > 0 && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              <p className="font-medium">Not removed:</p>
              <ul className="list-disc pl-5">
                {plan.skipped.map((s) => <li key={s.what}>{s.what}: {s.reason}</li>)}
              </ul>
            </div>
          )}

          {plan.blockers.length > 0 ? (
            <p className="text-sm text-red-700 dark:text-red-400">{plan.blockers.join(' ')}</p>
          ) : (
            <div className="space-y-2">
              <label className="block text-sm text-gray-700 dark:text-gray-200">
                Type <span className="font-mono font-semibold">{plan.project.name}</span> to confirm
              </label>
              <input
                type="text"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                className="w-full rounded-lg border border-gray-300 dark:border-white/8 px-3 py-2 focus:outline-hidden focus:ring-2 focus:ring-red-500"
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => { setPlan(null); setConfirm(''); setDeleteDatabase(false); setDeleteRemoteRepo(false); }}
                  disabled={wiping}
                  className="rounded-lg px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/6"
                >
                  Cancel
                </button>
                <button
                  onClick={wipe}
                  disabled={wiping || confirm !== plan.project.name}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {wiping ? 'Wiping…' : 'Permanently wipe project'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
