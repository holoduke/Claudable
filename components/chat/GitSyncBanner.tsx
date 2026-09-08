'use client';

/**
 * Self-contained "your project is behind the git repo" banner for the chat
 * screen. Polls GET /github/sync-status (on mount, on window focus, and every
 * few minutes), and when the remote branch has commits the working copy lacks,
 * offers one-click Update via the existing POST /github/pull route (which also
 * restarts the preview when files changed). Renders nothing when up to date,
 * not connected to git, or while an agent turn is running (pulling under a
 * running agent would fight it — the poll keeps running and the banner returns
 * when the turn ends).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/contexts/I18nContext';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

const POLL_MS = 5 * 60_000;
/** Focus events fire constantly while alt-tabbing; don't re-check more often than this. */
const FOCUS_THROTTLE_MS = 60_000;
const SUCCESS_HIDE_MS = 6_000;

interface SyncStatus {
  connected: boolean;
  behind: boolean;
  behind_by: number | null;
  remote_sha: string | null;
}

interface GitSyncBannerProps {
  projectId: string;
  /** True while an agent turn / active request is running — hides the banner. */
  busy: boolean;
  /** Called after a pull that actually changed files (e.g. refresh the preview). */
  onSynced?: () => void;
}

export default function GitSyncBanner({ projectId, busy, onSynced }: GitSyncBannerProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSynced, setJustSynced] = useState(false);
  // Dismissal is per remote head: a NEWER remote commit shows the banner again.
  const [dismissedSha, setDismissedSha] = useState<string | null>(null);
  const lastCheckRef = useRef(0);
  const syncingRef = useRef(false);

  const check = useCallback(async () => {
    if (syncingRef.current) return;
    lastCheckRef.current = Date.now();
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/github/sync-status`, { cache: 'no-store' });
      if (!res.ok) return; // not connected / no access / transient — stay quiet
      const json = await res.json();
      if (json?.success) {
        setStatus({
          connected: json.connected === true,
          behind: json.behind === true,
          behind_by: typeof json.behind_by === 'number' ? json.behind_by : null,
          remote_sha: typeof json.remote_sha === 'string' ? json.remote_sha : null,
        });
      }
    } catch {
      // Network hiccup: keep the last known status rather than flashing the UI.
    }
  }, [projectId]);

  useEffect(() => {
    check();
    const interval = setInterval(check, POLL_MS);
    const onFocus = () => {
      if (Date.now() - lastCheckRef.current >= FOCUS_THROTTLE_MS) check();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [check]);

  const update = async () => {
    setSyncing(true);
    syncingRef.current = true;
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/github/pull`, { method: 'POST' });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        throw new Error(json?.message || t('gitSync.failed'));
      }
      setStatus((prev) => (prev ? { ...prev, behind: false, behind_by: 0 } : prev));
      setJustSynced(true);
      setTimeout(() => setJustSynced(false), SUCCESS_HIDE_MS);
      if (json.updated) onSynced?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('gitSync.failed'));
    } finally {
      setSyncing(false);
      syncingRef.current = false;
    }
  };

  if (justSynced && !busy) {
    return (
      <div className="fixed top-14 left-1/2 -translate-x-1/2 z-40 max-w-[92%]">
        <div className="flex items-center gap-2 bg-green-600 text-white rounded-xl shadow-xl px-4 py-2 text-sm">
          <span aria-hidden>✓</span>
          <span>{t('gitSync.updated')}</span>
        </div>
      </div>
    );
  }

  const behind = status?.connected && status.behind;
  if (!behind || busy || (dismissedSha !== null && dismissedSha === status.remote_sha)) {
    return null;
  }

  const label =
    status.behind_by && status.behind_by > 0
      ? t('gitSync.behindCount', { count: status.behind_by })
      : t('gitSync.behind');

  return (
    <div className="fixed top-14 left-1/2 -translate-x-1/2 z-40 max-w-[92%]">
      <div className="flex items-center gap-3 bg-gray-900 dark:bg-white/10 dark:backdrop-blur text-white rounded-xl shadow-xl pl-4 pr-2 py-2 border border-white/10">
        <svg className="w-4 h-4 shrink-0 text-brand-400" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5h-3.32ZM8 10.25a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
        </svg>
        <span className="text-sm truncate" title={label}>{label}</span>
        {error && (
          <span className="text-xs text-red-300 max-w-[24rem] truncate" title={error}>{error}</span>
        )}
        <button
          onClick={update}
          disabled={syncing}
          className="shrink-0 text-xs font-semibold bg-brand-500 hover:bg-brand-600 text-white rounded-lg px-3 py-1.5 transition-colors disabled:opacity-60"
        >
          {syncing ? t('gitSync.updating') : t('gitSync.update')}
        </button>
        <button
          onClick={() => setDismissedSha(status.remote_sha)}
          disabled={syncing}
          className="shrink-0 text-white/70 hover:text-white text-sm px-1 disabled:opacity-40"
          aria-label={t('gitSync.dismiss')}
          title={t('gitSync.dismiss')}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
