"use client";
import { FaRocket } from 'react-icons/fa';
import { formatTimeAgo } from '@/lib/utils/format';
import type { DeployRun, DeployRunJob, DeploymentStatus } from '@/hooks/useDeployPolling';
import { useEffect, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/contexts/I18nContext';

/**
 * Pipeline step checklist + progress bar for a CI run (Vercel-style deploy
 * feedback): every job with a live state icon, and completed-vs-total
 * progress. Rendered in both the "deploying" and "failed" panels.
 */
function DeployJobList({ jobs, tone }: { jobs?: DeployRunJob[]; tone: 'blue' | 'red' }) {
  const t = useT();
  if (!jobs || jobs.length === 0) return null;
  const terminal = ['success', 'failure', 'cancelled', 'skipped'];
  const done = jobs.filter((j) => terminal.includes(j.status)).length;
  const pct = Math.round((done / jobs.length) * 100);
  // Stable keys from the job name; repeated names get an occurrence suffix.
  const seenNames = new Map<string, number>();
  const keyedJobs = jobs.map((job) => {
    const n = (seenNames.get(job.name) ?? 0) + 1;
    seenNames.set(job.name, n);
    return { job, key: n === 1 ? job.name : `${job.name}#${n}` };
  });
  const barBg = tone === 'blue' ? 'bg-blue-200/60 dark:bg-blue-900/50' : 'bg-red-200/60 dark:bg-red-900/50';
  const barFill = tone === 'blue' ? 'bg-blue-600 dark:bg-blue-400' : 'bg-red-600 dark:bg-red-400';
  const textDim = tone === 'blue' ? 'text-blue-700/80 dark:text-blue-300/80' : 'text-red-700/80 dark:text-red-300/80';

  const icon = (status: string) => {
    switch (status) {
      case 'success':
        return <svg className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={t('chat.publish.job.succeeded')}><polyline points="20 6 9 17 4 12" /></svg>;
      case 'failure':
        return <svg className="w-3.5 h-3.5 text-red-600 dark:text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" role="img" aria-label={t('chat.publish.job.failed')}><path d="M18 6L6 18M6 6l12 12" /></svg>;
      case 'cancelled':
        return <svg className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" role="img" aria-label={t('chat.publish.job.cancelled')}><circle cx="12" cy="12" r="9" /><line x1="7" y1="12" x2="17" y2="12" /></svg>;
      case 'skipped':
        return <svg className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" role="img" aria-label={t('chat.publish.job.skipped')}><polyline points="13 17 18 12 13 7" /><polyline points="6 17 11 12 6 7" /></svg>;
      case 'running':
        return <span className="w-3.5 h-3.5 border-2 border-blue-600 dark:border-blue-400 border-t-transparent rounded-full animate-spin" role="img" aria-label={t('chat.publish.job.running')} />;
      default: // queued / unknown
        return <span className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 dark:border-gray-600" role="img" aria-label={t('chat.publish.job.pending')} />;
    }
  };

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className={`h-1.5 flex-1 rounded-full overflow-hidden ${barBg}`}>
          <div className={`h-full rounded-full transition-all duration-500 ${barFill}`} style={{ width: `${pct}%` }} />
        </div>
        <span className={`text-[10px] tabular-nums ${textDim}`}>{done}/{jobs.length} · {pct}%</span>
      </div>
      <ul className="space-y-1">
        {keyedJobs.map(({ job: j, key }) => (
          <li key={key} className="flex items-center gap-2 text-xs">
            <span className="shrink-0 flex items-center justify-center w-4">{icon(j.status)}</span>
            <span className={`truncate ${j.status === 'skipped' || j.status === 'cancelled' ? 'text-gray-400 dark:text-gray-500 line-through' : 'text-gray-700 dark:text-gray-200'}`}>
              {j.name}
            </span>
            {j.status === 'running' && <span className={`ml-auto shrink-0 ${textDim}`}>{t('chat.publish.job.runningInline')}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';
const AGENT_BUSY_POLL_MS = 3000;

/** The push route refused (busy agent, missing repo, git failure): its message is meant for the user. */
class PushRejectedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'PushRejectedError';
  }
}

/** Turn a failed push response into a PushRejectedError carrying the server's message. */
async function pushRejection(res: Response, fallback: string): Promise<PushRejectedError> {
  const text = await res.text().catch(() => '');
  let message = '';
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : '';
  } catch {
    message = text.trim().slice(0, 300);
  }
  return new PushRejectedError(message || fallback, res.status);
}

/**
 * Whether an agent turn is running for the project, polled while the panel is
 * open. A failed poll keeps the last known value — the server-side 409 is the
 * real gate, this only spares the user a doomed click.
 */
function useAgentBusy(projectId: string): [boolean, (busy: boolean) => void] {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/chat/${projectId}/requests/active`, { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { agentRunning?: unknown };
        // Same rule as the server's push guard: only a turn that holds the run slot.
        if (!cancelled) setBusy(body.agentRunning === true);
      } catch {
        /* keep the last known state */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), AGENT_BUSY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId]);
  return [busy, setBusy];
}

interface DeployLogData { found: boolean; runNumber?: number; job?: string; errors: string[]; tail: string; truncated: boolean }

/**
 * The failed run's build log, read through Claudable (no Gitea account needed):
 * the error lines first, the tail behind a disclosure, plus "let the AI fix it".
 */
function DeployLogView({ projectId, onFix }: { projectId: string; onFix?: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [log, setLog] = useState<DeployLogData | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || state === 'loading' || state === 'ready') return;
    setState('loading');
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/deploy/log`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) throw new Error('log');
      setLog(body as DeployLogData);
      setState('ready');
    } catch {
      setState('error');
    }
  };

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="px-3 py-1.5 text-xs rounded-lg border border-red-300/80 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40"
        >
          {open ? t('chat.publish.log.hide') : t('chat.publish.log.show')}
        </button>
        {onFix && (
          <button
            type="button"
            onClick={onFix}
            className="px-3 py-1.5 text-xs rounded-lg bg-red-600 text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600"
          >
            {t('chat.publish.log.fix')}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-3 space-y-2" aria-live="polite">
          {state === 'loading' && <p className="text-xs text-red-700/80 dark:text-red-300/80">{t('chat.publish.log.loading')}</p>}
          {state === 'error' && <p className="text-xs text-red-700 dark:text-red-300">{t('chat.publish.log.failed')}</p>}
          {state === 'ready' && log && !log.found && <p className="text-xs text-red-700/80 dark:text-red-300/80">{t('chat.publish.log.none')}</p>}
          {state === 'ready' && log?.found && (
            <>
              {log.errors.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-red-800 dark:text-red-200 mb-1">{t('chat.publish.log.errors')}</p>
                  <pre className="text-[11px] leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-auto rounded-lg bg-white/70 dark:bg-black/30 border border-red-200 dark:border-red-900 p-2 text-red-900 dark:text-red-100">{log.errors.join('\n')}</pre>
                </div>
              )}
              <details>
                <summary className="text-xs cursor-pointer text-red-700 dark:text-red-300">{t('chat.publish.log.tail')}{log.job ? ` · ${log.job}` : ''}</summary>
                <pre className="mt-1 text-[11px] leading-relaxed whitespace-pre-wrap break-words max-h-72 overflow-auto rounded-lg bg-white/70 dark:bg-black/30 border border-red-200 dark:border-red-900 p-2 text-gray-800 dark:text-gray-200">{log.tail || '—'}</pre>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface PublishPanelProps {
  projectId: string;
  isGitea: boolean;
  deploymentStatus: DeploymentStatus;
  setDeploymentStatus: (status: DeploymentStatus) => void;
  deployRun: DeployRun | null;
  setDeployRun: (run: DeployRun | null) => void;
  publishedUrl: string | null;
  setPublishedUrl: (url: string | null) => void;
  githubConnected: boolean | null;
  vercelConnected: boolean | null;
  githubRepoName: string | null;
  gitDeployDomain: string | null;
  publishLoading: boolean;
  setPublishLoading: (loading: boolean) => void;
  startGiteaDeployPolling: (baselineRun?: number | null) => void;
  startDeploymentPolling: (depId: string) => void;
  loadDeployStatus: () => Promise<void>;
  onClose: () => void;
  onOpenServiceSettings: () => void;
  /** The branch Publish pushes to, and the base branch the site deploys from. */
  branch?: string | null;
  baseBranch?: string | null;
  /** Merge the current branch into the base branch (and follow the deploy). */
  onMergeBranch?: () => Promise<void>;
  /** The parent already knows an agent turn is running (combined with the panel's own poll). */
  agentBusy?: boolean;
  /** Ask the agent to read the failed deploy's build log and fix the cause. */
  onFixDeploy?: () => void;
}

/**
 * Publish modal: Git connect warnings, publish/update button flow (Gitea push
 * + Actions run, or GitHub push + Vercel deploy), and deployment status panels.
 * Extracted verbatim from app/[project_id]/chat/page.tsx.
 */
export default function PublishPanel({
  projectId,
  isGitea,
  deploymentStatus,
  setDeploymentStatus,
  deployRun,
  setDeployRun,
  publishedUrl,
  setPublishedUrl,
  githubConnected,
  vercelConnected,
  githubRepoName,
  gitDeployDomain,
  publishLoading,
  setPublishLoading,
  startGiteaDeployPolling,
  startDeploymentPolling,
  loadDeployStatus,
  onClose,
  onOpenServiceSettings,
  branch = null,
  baseBranch = null,
  onMergeBranch,
  agentBusy: agentBusyProp = false,
  onFixDeploy,
}: PublishPanelProps) {
  const toast = useToast();
  const t = useT();
  // Is there anything new to publish? (uncommitted edits or unpushed commits;
  // see lib/services/git-sync-status.ts). Re-checked when a publish finishes.
  const [pending, setPending] = useState<{ unpublished: boolean; count: number } | null>(null);
  useEffect(() => {
    if (!isGitea || deploymentStatus === 'deploying' || publishLoading) return;
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/projects/${projectId}/github/sync-status`, { cache: 'no-store', signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.success || !d.connected) return;
        setPending({ unpublished: !!d.unpublished, count: (d.dirty_files || 0) + (d.ahead_by || 0) });
      })
      .catch(() => { /* aborted or offline: keep the plain "Update" label */ });
    return () => ctrl.abort();
  }, [projectId, isGitea, deploymentStatus, publishLoading]);
  const [polledAgentBusy, setPolledAgentBusy] = useAgentBusy(projectId);
  const agentBusy = agentBusyProp || polledAgentBusy;
  /** Show a push failure: the server's own message when it gave one. */
  const reportPushFailure = (e: unknown, fallback: string) => {
    if (e instanceof PushRejectedError) {
      if (e.status === 409) setPolledAgentBusy(true);
      toast.error(e.message);
    } else {
      toast.error(fallback);
    }
  };
  // On a non-base branch Publish only pushes the branch: nothing deploys until
  // the branch is merged into the base branch.
  const branchMode = !!branch && !!baseBranch && branch !== baseBranch;
  // Already live and nothing new: "Update" would only re-run the same deploy.
  const nothingNew = isGitea && !branchMode && !!publishedUrl && pending?.unpublished === false
    && deploymentStatus !== 'deploying' && deploymentStatus !== 'error' && !publishLoading;
  const [branchPushed, setBranchPushed] = useState(false);
  const [merging, setMerging] = useState(false);
  const publishBranch = async () => {
    try {
      setPublishLoading(true);
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/github/push`, { method: 'POST' });
      if (!res.ok) throw await pushRejection(res, t('chat.publish.failedHttp', { status: res.status }));
      const body = await res.json().catch(() => ({}));
      if (body?.success === false) throw new PushRejectedError(body?.message || t('chat.publish.failed'), res.status);
      setBranchPushed(true);
      toast.success(t('publish.branchPushed', { branch: branch ?? '' }));
    } catch (e) {
      reportPushFailure(e, e instanceof Error && e.message ? e.message : t('chat.publish.failed'));
    } finally {
      setPublishLoading(false);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const mergeNow = async () => {
    if (!onMergeBranch) return;
    setMerging(true);
    try { await onMergeBranch(); } finally { setMerging(false); }
  };
  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="publish-panel-title">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white dark:bg-[#181310] border border-gray-200 dark:border-white/10 rounded-2xl shadow-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-white/8 flex items-center justify-between bg-gray-50 dark:bg-white/3 ">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white bg-black border border-black/10 ">
              <FaRocket size={14} aria-hidden="true" />
            </div>
            <div>
              <h3 id="publish-panel-title" className="text-base font-semibold text-gray-900 dark:text-gray-50 ">{t('chat.publish.title')}</h3>
              <p className="text-xs text-gray-600 dark:text-gray-300 ">{branchMode ? t('publish.branchTitle', { branch: branch ?? '' }) : isGitea ? t('chat.publish.subtitleGit') : t('chat.publish.subtitleVercel')}</p>
            </div>
          </div>
          <button onClick={onClose} aria-label={t('common.close')} title={t('common.close')} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 ">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          {branchMode && (
            <div className="p-4 rounded-xl border border-violet-200 bg-violet-50 dark:border-violet-900 dark:bg-violet-950/40">
              <p className="text-sm text-violet-800 dark:text-violet-200">{t('publish.branchNote', { branch: branch ?? '', base: baseBranch ?? '' })}</p>
              {branchPushed && (
                <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">✓ {t('publish.branchPushed', { branch: branch ?? '' })}</p>
              )}
              {onMergeBranch && (
                <button
                  disabled={merging || publishLoading || agentBusy || deploymentStatus === 'deploying'}
                  onClick={() => void mergeNow()}
                  className="mt-3 w-full px-3 py-2 rounded-lg border border-violet-300 dark:border-violet-800 text-sm font-medium text-violet-800 dark:text-violet-200 hover:bg-violet-100 dark:hover:bg-violet-900/50 disabled:opacity-50"
                >
                  {merging ? t('branch.merging') : t('publish.mergeNow', { branch: branch ?? '', base: baseBranch ?? '' })}
                </button>
              )}
            </div>
          )}

          {deploymentStatus === 'deploying' && (
            <div className="p-4 rounded-xl border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/40 ">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-4 h-4 border-2 border-blue-600 dark:border-blue-400 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm font-medium text-blue-700 dark:text-blue-300 ">
                  {deployRun?.state === 'queued' ? t('chat.publish.stateQueued')
                    : deployRun?.state === 'running' ? t('chat.publish.stateRunning')
                    : t('chat.publish.statePushing')}
                </p>
              </div>
              <p className="text-xs text-blue-700/80 dark:text-blue-300/80">
                {isGitea
                  ? t('chat.publish.liveStatusGit')
                  : t('chat.publish.liveStatusVercel')}
              </p>
              <DeployJobList jobs={deployRun?.jobs} tone="blue" />
              {isGitea && publishedUrl && (
                <p className="text-xs text-blue-700/80 dark:text-blue-300/80mt-1">{t('chat.publish.willBeLive')} <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="font-mono underline">{publishedUrl}</a></p>
              )}
              {isGitea && deployRun?.url && (
                <p className="text-xs text-blue-700/80 dark:text-blue-300/80mt-1">
                  <a href={deployRun.url} target="_blank" rel="noopener noreferrer" className="underline">
                    {deployRun.runNumber ? t('chat.publish.viewLogRun', { run: deployRun.runNumber }) : t('chat.publish.viewLog')} →
                  </a>
                </p>
              )}
            </div>
          )}

          {/* Neutral "currently live" state shown when the popup opens for an
              already-deployed project (before the user clicks Update). */}
          {deploymentStatus !== 'deploying' && deploymentStatus !== 'ready' && deploymentStatus !== 'error' && isGitea && publishedUrl && (
            <div className="p-4 rounded-xl border border-gray-200 dark:border-white/8 bg-gray-50 dark:bg-white/3 ">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">{t('chat.publish.currentlyLive')}</p>
              <div className="flex items-center gap-2">
                <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-mono text-gray-700 dark:text-gray-200 underline break-all flex-1">
                  {publishedUrl}
                </a>
                <button
                  onClick={() => navigator.clipboard?.writeText(publishedUrl)}
                  className="px-2 py-1 text-xs rounded-lg border border-gray-300 dark:border-white/8 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/6 "
                >
                  {t('common.copy')}
                </button>
              </div>
              {deployRun?.state === 'success' && (deployRun?.title || deployRun?.updatedAt) && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  {t('chat.publish.lastDeployed')}{formatTimeAgo(deployRun.updatedAt) ? ` ${formatTimeAgo(deployRun.updatedAt)}` : ''}
                  {deployRun.title ? ` · ${deployRun.title}` : ''}
                  {deployRun.sha ? ` (${deployRun.sha})` : ''}
                  {deployRun.url ? <> · <a href={deployRun.url} target="_blank" rel="noopener noreferrer" className="underline">{t('chat.publish.log')}</a></> : null}
                </p>
              )}
              {!branchMode && (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                  {pending && !pending.unpublished ? t('chat.publish.upToDate') : t('chat.publish.clickUpdate')}
                </p>
              )}
            </div>
          )}

          {deploymentStatus === 'ready' && publishedUrl && (
            <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 ">
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300 mb-2">{t('chat.publish.success')}</p>
              <div className="flex items-center gap-2">
                <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-mono text-emerald-700 dark:text-emerald-300 underline break-all flex-1">
                  {publishedUrl}
                </a>
                <button
                  onClick={() => navigator.clipboard?.writeText(publishedUrl)}
                  className="px-2 py-1 text-xs rounded-lg border border-emerald-300/80 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 "
                >
                  {t('common.copy')}
                </button>
              </div>
            </div>
          )}

          {deploymentStatus === 'error' && (
            <div className="p-4 rounded-xl border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40 ">
              <p className="text-sm font-medium text-red-700 dark:text-red-300 ">
                {deployRun?.state === 'cancelled' ? t('chat.publish.errCancelled')
                  : deployRun?.state === 'unknown' ? t('chat.publish.errTimeout')
                  : t('chat.publish.errFailed')}
              </p>
              <DeployJobList jobs={deployRun?.jobs} tone="red" />
              {isGitea && <DeployLogView projectId={projectId} onFix={onFixDeploy} />}
              {isGitea && deployRun?.url && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-2">
                  <a href={deployRun.url} target="_blank" rel="noopener noreferrer" className="underline">
                    {t('chat.publish.log.gitea')} →
                  </a>
                </p>
              )}
            </div>
          )}

          {!githubConnected || (!isGitea && !vercelConnected) ? (
            <div className="p-4 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 ">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-50 mb-2">{t('chat.publish.connectServices')}</p>
              <div className="space-y-1 text-amber-700 dark:text-amber-300 text-sm">
                {!githubConnected && (<div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-amber-500"/>{t('chat.publish.gitNotConnected')}</div>)}
                {!isGitea && !vercelConnected && (<div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-amber-500"/>{t('chat.publish.vercelNotConnected')}</div>)}
              </div>
              <button
                className="mt-3 w-full px-4 py-2 rounded-xl border border-gray-200 dark:border-white/8 text-gray-800 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-white/6 "
                onClick={onOpenServiceSettings}
              >
                {t('chat.publish.openServices')}
              </button>
            </div>
          ) : null}

          {agentBusy && (
            <div role="status" className="p-3 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 text-sm text-amber-800 dark:text-amber-200">
              {t('chat.publish.agentBusyNote')}
            </div>
          )}

          <button
            disabled={nothingNew || agentBusy || publishLoading || deploymentStatus === 'deploying' || !githubConnected || (!isGitea && !vercelConnected)}
            onClick={async () => {
              if (branchMode) { await publishBranch(); return; }
              // Self-hosted Gitea flow: push to the Gitea repo; the Actions
              // host-runner builds, deploys and routes the site. No Vercel.
              if (isGitea) {
                try {
                  setPublishLoading(true);
                  setDeploymentStatus('deploying');
                  setDeployRun({ state: 'queued' });
                  // Record the latest run number BEFORE pushing so polling
                  // only tracks the NEW run this publish creates.
                  let baselineRun: number | null = null;
                  try {
                    const s = await fetch(`${API_BASE}/api/projects/${projectId}/deploy/status`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null);
                    baselineRun = s?.found && typeof s.runNumber === 'number' ? s.runNumber : null;
                  } catch {}
                  const pushRes = await fetch(`${API_BASE}/api/projects/${projectId}/github/push`, { method: 'POST' });
                  if (!pushRes.ok) {
                    throw await pushRejection(pushRes, t('chat.publish.failedHttp', { status: pushRes.status }));
                  }
                  const pushBody = await pushRes.json().catch(() => ({}));
                  const url = githubRepoName && gitDeployDomain
                    ? `https://${githubRepoName}.${gitDeployDomain}`
                    : publishedUrl;
                  if (url) setPublishedUrl(url);
                  setPublishLoading(false);
                  if (pushBody.pushed === false) {
                    // Nothing new to push — but that does NOT mean the site is
                    // live: the code may have been pushed earlier (auto-sync)
                    // with its CI run FAILING. Report the latest run's real
                    // state instead of claiming success.
                    const s = await fetch(`${API_BASE}/api/projects/${projectId}/deploy/status`, { cache: 'no-store' })
                      .then(r => (r.ok ? r.json() : null))
                      .catch(() => null);
                    if (s?.found && (s.state === 'failure' || s.state === 'cancelled')) {
                      setDeployRun({ state: s.state, jobs: s.jobs, runNumber: s.runNumber, url: s.url, title: s.title, sha: s.sha, updatedAt: s.updatedAt });
                      setDeploymentStatus('error');
                      toast.error(t('chat.publish.nothingNewFailed'));
                    } else if (s?.found && (s.state === 'queued' || s.state === 'running')) {
                      // A run for the already-pushed commit is still going —
                      // track it to its real outcome.
                      startGiteaDeployPolling(null);
                    } else {
                      // Latest run succeeded (or no CI configured) — already live.
                      setDeployRun(null);
                      setDeploymentStatus('ready');
                    }
                  } else {
                    // Track the real Gitea Actions run (queued -> running ->
                    // success/failure) instead of guessing with a timer.
                    startGiteaDeployPolling(baselineRun);
                  }
                } catch (e) {
                  console.error('🚀 Gitea publish failed:', e);
                  reportPushFailure(e, t('chat.publish.failedGitea'));
                  setDeploymentStatus('idle');
                  setPublishLoading(false);
                }
                return;
              }
              try {
                setPublishLoading(true);
                setDeploymentStatus('deploying');
                // 1) Push to GitHub to ensure branch/commit exists
                try {
                  const pushRes = await fetch(`${API_BASE}/api/projects/${projectId}/github/push`, { method: 'POST' });
                  if (!pushRes.ok) {
                    const err = await pushRejection(pushRes, t('chat.publish.failedHttp', { status: pushRes.status }));
                    console.error('🚀 GitHub push failed:', err.message);
                    throw err;
                  }
                } catch (e) {
                  console.error('🚀 GitHub push step failed', e);
                  throw e;
                }
                // Small grace period to let GitHub update default branch
                await new Promise(r => setTimeout(r, 800));
                // 2) Deploy to Vercel (branch auto-resolved on server)
                const deployUrl = `${API_BASE}/api/projects/${projectId}/vercel/deploy`;
                const vercelRes = await fetch(deployUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ branch: 'main' })
                });
                if (vercelRes.ok) {
                  const data = await vercelRes.json();
                  setDeploymentStatus('deploying');
                  if (data.deployment_id) startDeploymentPolling(data.deployment_id);
                  if (data.ready && data.deployment_url) {
                    const url = data.deployment_url.startsWith('http') ? data.deployment_url : `https://${data.deployment_url}`;
                    setPublishedUrl(url);
                    setDeploymentStatus('ready');
                  }
                } else {
                  const errorText = await vercelRes.text();
                  console.error('🚀 Vercel deploy failed:', vercelRes.status, errorText);
                  // Show the failure panel — 'idle' made the failure invisible.
                  setDeploymentStatus('error');
                  setPublishLoading(false);
                }
              } catch (e) {
                console.error('🚀 Publish failed:', e);
                reportPushFailure(e, t('chat.publish.failedGeneric'));
                setDeploymentStatus('idle');
                setPublishLoading(false);
                // Keep the panel open for a busy agent so the explanation stays visible.
                if (!(e instanceof PushRejectedError && e.status === 409)) setTimeout(() => onClose(), 1000);
              } finally {
                loadDeployStatus();
              }
            }}
            className={`w-full px-4 py-3 rounded-xl font-medium text-white transition ${
              nothingNew || agentBusy || publishLoading || deploymentStatus === 'deploying' || !githubConnected || (!isGitea && !vercelConnected)
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-brand-500 hover:bg-brand-600'
            }`}
          >
            {publishLoading ? t('chat.publish.btnPublishing') : agentBusy && deploymentStatus !== 'deploying' ? t('chat.publish.btnAgentWorking') : deploymentStatus === 'deploying' ? t('chat.publish.btnDeploying') : (!githubConnected || (!isGitea && !vercelConnected)) ? t('chat.publish.btnConnectFirst') : branchMode ? t('publish.branchTitle', { branch: branch ?? '' }) : nothingNew ? t('chat.publish.btnUpToDate') : (publishedUrl ? (pending?.unpublished && pending.count > 0 ? t(pending.count === 1 ? 'chat.publish.btnUpdateOne' : 'chat.publish.btnUpdateCount', { count: pending.count }) : t('chat.publish.btnUpdate')) : t('chat.publish.btnPublish'))}
          </button>
        </div>
      </div>
    </div>
  );
}
