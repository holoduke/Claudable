"use client";
import { FaRocket } from 'react-icons/fa';
import { formatTimeAgo } from '@/lib/utils/format';
import type { DeployRun, DeploymentStatus } from '@/hooks/useDeployPolling';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

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
}: PublishPanelProps) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between bg-gray-50 dark:bg-gray-900/60 ">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white bg-black border border-black/10 ">
              <FaRocket size={14} />
            </div>
            <div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-50 ">Publish Project</h3>
              <p className="text-xs text-gray-600 dark:text-gray-300 ">{isGitea ? 'Pushes your code to Git — auto-deploys via CI' : 'Deploy with Vercel, linked to your GitHub repo'}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 ">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          {deploymentStatus === 'deploying' && (
            <div className="p-4 rounded-xl border border-blue-200 bg-blue-50 ">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm font-medium text-blue-700 ">
                  {deployRun?.state === 'queued' ? 'Queued — waiting for the runner…'
                    : deployRun?.state === 'running' ? 'Building & deploying…'
                    : 'Pushing to the repository…'}
                </p>
              </div>
              <p className="text-xs text-blue-700/80 ">
                {isGitea
                  ? 'Live status from CI — clone, build, route, health check.'
                  : 'Building and deploying your project. This may take a few minutes.'}
              </p>
              {isGitea && publishedUrl && (
                <p className="text-xs text-blue-700/80 mt-1">Will be live at <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="font-mono underline">{publishedUrl}</a></p>
              )}
              {isGitea && deployRun?.url && (
                <p className="text-xs text-blue-700/80 mt-1">
                  <a href={deployRun.url} target="_blank" rel="noopener noreferrer" className="underline">
                    View build log{deployRun.runNumber ? ` (run #${deployRun.runNumber})` : ''} →
                  </a>
                </p>
              )}
            </div>
          )}

          {/* Neutral "currently live" state shown when the popup opens for an
              already-deployed project (before the user clicks Update). */}
          {deploymentStatus !== 'deploying' && deploymentStatus !== 'ready' && deploymentStatus !== 'error' && isGitea && publishedUrl && (
            <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 ">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">Currently live at:</p>
              <div className="flex items-center gap-2">
                <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-mono text-gray-700 dark:text-gray-200 underline break-all flex-1">
                  {publishedUrl}
                </a>
                <button
                  onClick={() => navigator.clipboard?.writeText(publishedUrl)}
                  className="px-2 py-1 text-xs rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 "
                >
                  Copy
                </button>
              </div>
              {deployRun?.state === 'success' && (deployRun?.title || deployRun?.updatedAt) && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  Last deployed{formatTimeAgo(deployRun.updatedAt) ? ` ${formatTimeAgo(deployRun.updatedAt)}` : ''}
                  {deployRun.title ? ` · ${deployRun.title}` : ''}
                  {deployRun.sha ? ` (${deployRun.sha})` : ''}
                  {deployRun.url ? <> · <a href={deployRun.url} target="_blank" rel="noopener noreferrer" className="underline">log</a></> : null}
                </p>
              )}
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">Click Update to deploy your latest changes.</p>
            </div>
          )}

          {deploymentStatus === 'ready' && publishedUrl && (
            <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50 ">
              <p className="text-sm font-medium text-emerald-700 mb-2">Published successfully</p>
              <div className="flex items-center gap-2">
                <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-mono text-emerald-700 underline break-all flex-1">
                  {publishedUrl}
                </a>
                <button
                  onClick={() => navigator.clipboard?.writeText(publishedUrl)}
                  className="px-2 py-1 text-xs rounded-lg border border-emerald-300/80 text-emerald-700 hover:bg-emerald-100 "
                >
                  Copy
                </button>
              </div>
            </div>
          )}

          {deploymentStatus === 'error' && (
            <div className="p-4 rounded-xl border border-red-200 bg-red-50 ">
              <p className="text-sm font-medium text-red-700 ">
                {deployRun?.state === 'cancelled' ? 'Deployment was cancelled.' : 'Deployment failed.'}
              </p>
              {isGitea && deployRun?.url && (
                <p className="text-xs text-red-600 mt-1">
                  <a href={deployRun.url} target="_blank" rel="noopener noreferrer" className="underline">
                    View the failed build log{deployRun.runNumber ? ` (run #${deployRun.runNumber})` : ''} →
                  </a>
                </p>
              )}
            </div>
          )}

          {!githubConnected || (!isGitea && !vercelConnected) ? (
            <div className="p-4 rounded-xl border border-amber-200 bg-amber-50 ">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-50 mb-2">Connect the following services:</p>
              <div className="space-y-1 text-amber-700 text-sm">
                {!githubConnected && (<div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-amber-500"/>Git repository not connected</div>)}
                {!isGitea && !vercelConnected && (<div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-amber-500"/>Vercel project not connected</div>)}
              </div>
              <button
                className="mt-3 w-full px-4 py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 "
                onClick={onOpenServiceSettings}
              >
                Open Settings → Services
              </button>
            </div>
          ) : null}

          <button
            disabled={publishLoading || deploymentStatus === 'deploying' || !githubConnected || (!isGitea && !vercelConnected)}
            onClick={async () => {
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
                    throw new Error(await pushRes.text());
                  }
                  const pushBody = await pushRes.json().catch(() => ({}));
                  const url = githubRepoName && gitDeployDomain
                    ? `https://${githubRepoName}.${gitDeployDomain}`
                    : publishedUrl;
                  if (url) setPublishedUrl(url);
                  setPublishLoading(false);
                  if (pushBody.pushed === false) {
                    // Nothing changed since the last deploy — it's already live.
                    setDeployRun(null);
                    setDeploymentStatus('ready');
                  } else {
                    // Track the real Gitea Actions run (queued -> running ->
                    // success/failure) instead of guessing with a timer.
                    startGiteaDeployPolling(baselineRun);
                  }
                } catch (e) {
                  console.error('🚀 Gitea publish failed:', e);
                  alert('Publish failed. Make sure the project is connected to Gitea in Settings → Services.');
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
                    const err = await pushRes.text();
                    console.error('🚀 GitHub push failed:', err);
                    throw new Error(err);
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
                alert('Publish failed. Check Settings and tokens.');
                setDeploymentStatus('idle');
                setPublishLoading(false);
                setTimeout(() => onClose(), 1000);
              } finally {
                loadDeployStatus();
              }
            }}
            className={`w-full px-4 py-3 rounded-xl font-medium text-white transition ${
              publishLoading || deploymentStatus === 'deploying' || !githubConnected || (!isGitea && !vercelConnected)
                ? 'bg-gray-400 cursor-not-allowed'
                : 'bg-black hover:bg-gray-900 dark:hover:bg-gray-200'
            }`}
          >
            {publishLoading ? 'Publishing…' : deploymentStatus === 'deploying' ? 'Deploying…' : (!githubConnected || (!isGitea && !vercelConnected)) ? 'Connect Services First' : (publishedUrl ? 'Update' : 'Publish')}
          </button>
        </div>
      </div>
    </div>
  );
}
