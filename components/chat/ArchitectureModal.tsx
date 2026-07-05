"use client";
import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Container {
  kind: string; id?: string; name: string; type: string; status: string;
  url: string | null; icon?: string;
}

const KIND_ICON: Record<string, string> = { frontend: '🖥️', backend: '⚙️', database: '🗄️', service: '📦' };

function dot(status: string): string {
  if (status === 'running' || status === 'provisioned' || status === 'container') return 'bg-emerald-500';
  if (status === 'file') return 'bg-blue-400';
  return 'bg-gray-400';
}

/**
 * The project's real runtime containers — image, status, and internal/public
 * address, straight from Docker. No generated prose; just the live data.
 */
export default function ArchitectureModal({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setContainers([]);
    setLoading(true);
    fetch(`${API_BASE}/api/projects/${projectId}/containers`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setContainers((j?.data?.containers ?? j?.containers ?? []) as Container[]); })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Project containers">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[82vh] overflow-hidden rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#181310] shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-white/[0.08] bg-gradient-to-r from-gray-50 to-gray-100 dark:from-white/[0.06] dark:to-white/[0.03]">
          <div className="flex items-center gap-2.5">
            <span className="h-8 w-8 flex items-center justify-center rounded-lg bg-[#DE7356]/15 text-[#DE7356] text-sm font-bold">i</span>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Containers</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-white/[0.06] transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
          ) : containers.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No containers for this project.</p>
          ) : (
            <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] divide-y divide-gray-100 dark:divide-white/[0.08] overflow-hidden">
              {containers.map((c) => (
                <div key={c.id || c.kind} className="flex items-center gap-3 px-4 py-3">
                  <span className="text-base leading-none" aria-hidden>{c.icon || KIND_ICON[c.kind] || '📦'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{c.name}</span>
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                        <span className={`w-2 h-2 rounded-full ${dot(c.status)}`} />{c.status}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-gray-500 dark:text-gray-400 truncate">{c.type}</div>
                  </div>
                  {c.url && <span className="text-[11px] font-mono text-gray-500 dark:text-gray-400 shrink-0">{c.url}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
