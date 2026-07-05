"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export type DeployRun = { state: string; runNumber?: number; url?: string; title?: string; sha?: string; updatedAt?: string };
export type DeploymentStatus = 'idle' | 'deploying' | 'ready' | 'error';

/**
 * Deployment polling state + pollers for the chat page's publish flow:
 * the Vercel deployment poller and the Gitea Actions run poller.
 * Extracted verbatim from app/[project_id]/chat/page.tsx.
 */
export function useDeployPolling({
  projectId,
  setPublishLoading,
  setShowPublishPanel,
}: {
  projectId: string;
  setPublishLoading: Dispatch<SetStateAction<boolean>>;
  setShowPublishPanel: Dispatch<SetStateAction<boolean>>;
}) {
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [deploymentStatus, setDeploymentStatus] = useState<DeploymentStatus>('idle');
  const deployPollRef = useRef<NodeJS.Timeout | null>(null);
  // Real CI deploy run details (Gitea Actions) for the publish UI.
  const [deployRun, setDeployRun] = useState<DeployRun | null>(null);
  const giteaPollRef = useRef<NodeJS.Timeout | null>(null);

  // Poll the REAL Gitea Actions deploy run (queued -> running -> success/failure)
  // instead of guessing with a timer. Stops on a terminal state or timeout.
  // Poll the REAL Gitea Actions deploy run. `baselineRun` is the latest run
  // number BEFORE this publish — we only treat a run NEWER than it as "this
  // deploy", otherwise the first poll reads the previous (already-finished) run
  // and stops instantly (the "first click does nothing" bug).
  const startGiteaDeployPolling = useCallback((baselineRun?: number | null) => {
    if (giteaPollRef.current) { clearInterval(giteaPollRef.current); giteaPollRef.current = null; }
    setDeploymentStatus('deploying');
    const startedAt = Date.now();
    const stop = () => { if (giteaPollRef.current) { clearInterval(giteaPollRef.current); giteaPollRef.current = null; } };
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/projects/${projectId}/deploy/status`, { cache: 'no-store' });
        if (r.ok) {
          const d = await r.json();
          if (d?.found) {
            const isNewRun = baselineRun == null
              || (typeof d.runNumber === 'number' && d.runNumber > baselineRun);
            if (!isNewRun) {
              // The new run hasn't registered yet — keep showing "queued".
              setDeployRun({ state: 'queued' });
              // If no new run appears within 40s, there was nothing to deploy
              // (no changes) — the site is already live from the prior run.
              if (Date.now() - startedAt > 40000) {
                setDeploymentStatus('ready'); stop(); return;
              }
            } else {
              setDeployRun({ state: d.state, runNumber: d.runNumber, url: d.url, title: d.title, sha: d.sha, updatedAt: d.updatedAt });
              if (d.state === 'success') {
                if (d.liveUrl) setPublishedUrl(d.liveUrl);
                setDeploymentStatus('ready'); stop(); return;
              }
              if (d.state === 'failure' || d.state === 'cancelled') {
                setDeploymentStatus('error'); stop(); return;
              }
            }
          }
        }
      } catch {
        // transient; keep polling
      }
      // Safety timeout (~6 min) so it never spins forever.
      if (Date.now() - startedAt > 6 * 60 * 1000) stop();
    };
    poll();
    giteaPollRef.current = setInterval(poll, 4000);
  }, [projectId]);

  const startDeploymentPolling = useCallback((depId: string) => {
    if (deployPollRef.current) clearInterval(deployPollRef.current);
    setDeploymentStatus('deploying');
    setDeploymentId(depId);

    console.log('🔍 Monitoring deployment:', depId);

    deployPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/projects/${projectId}/vercel/deployment/current`);
        if (r.status === 404) {
          setDeploymentStatus('idle');
          setDeploymentId(null);
          setPublishLoading(false);
          if (deployPollRef.current) {
            clearInterval(deployPollRef.current);
            deployPollRef.current = null;
          }
          return;
        }
        if (!r.ok) return;
        const data = await r.json();

        // Stop polling if no active deployment (completed)
        if (!data.has_deployment) {
          console.log('🔍 Deployment completed - no active deployment');

          // Set final deployment URL
          if (data.last_deployment_url) {
            const url = String(data.last_deployment_url).startsWith('http') ? data.last_deployment_url : `https://${data.last_deployment_url}`;
            console.log('🔍 Deployment complete! URL:', url);
            setPublishedUrl(url);
            setDeploymentStatus('ready');
          } else {
            setDeploymentStatus('idle');
          }

          // End publish loading state (important: release loading even if no deployment)
          setPublishLoading(false);

          if (deployPollRef.current) {
            clearInterval(deployPollRef.current);
            deployPollRef.current = null;
          }
          return;
        }

        // If there is an active deployment
        const status = data.status;

        // Log only status changes
        if (status && status !== 'QUEUED') {
          console.log('🔍 Deployment status:', status);
        }

        // Check if deployment is ready or failed
        const isReady = status === 'READY';
        const isBuilding = status === 'BUILDING' || status === 'QUEUED';
        const isError = status === 'ERROR';

        if (isError) {
          console.error('🔍 Deployment failed:', status);
          setDeploymentStatus('error');

          // End publish loading state
          setPublishLoading(false);

          // Close publish panel after error (with delay to show error message)
          setTimeout(() => {
            setShowPublishPanel(false);
          }, 3000); // Show error for 3 seconds before closing

          if (deployPollRef.current) {
            clearInterval(deployPollRef.current);
            deployPollRef.current = null;
          }
          return;
        }

        if (isReady && data.deployment_url) {
          const url = String(data.deployment_url).startsWith('http') ? data.deployment_url : `https://${data.deployment_url}`;
          console.log('🔍 Deployment complete! URL:', url);
          setPublishedUrl(url);
          setDeploymentStatus('ready');

          // End publish loading state
          setPublishLoading(false);

          // Keep panel open to show the published URL

          if (deployPollRef.current) {
            clearInterval(deployPollRef.current);
            deployPollRef.current = null;
          }
        } else if (isBuilding) {
          setDeploymentStatus('deploying');
        }
      } catch (error) {
        console.error('🔍 Polling error:', error);
      }
    }, 1000); // Changed to 1 second interval
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Stop deploy/publish pollers so they don't keep hitting the API after the
  // chat page unmounts (e.g. navigating back to the dashboard). The preview
  // itself is deliberately left running (see the chat page) so it stays warm.
  useEffect(() => {
    return () => {
      if (deployPollRef.current) { clearInterval(deployPollRef.current); deployPollRef.current = null; }
      if (giteaPollRef.current) { clearInterval(giteaPollRef.current); giteaPollRef.current = null; }
    };
  }, [projectId]);

  return {
    publishedUrl,
    setPublishedUrl,
    deploymentId,
    setDeploymentId,
    deploymentStatus,
    setDeploymentStatus,
    deployRun,
    setDeployRun,
    deployPollRef,
    giteaPollRef,
    startGiteaDeployPolling,
    startDeploymentPolling,
  };
}
