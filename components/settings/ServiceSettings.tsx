/**
 * Service Settings Component
 * Manage service integrations
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import GitHubRepoModal from '@/components/modals/GitHubRepoModal';
import VercelProjectModal from '@/components/modals/VercelProjectModal';
import SupabaseModal from '@/components/modals/SupabaseModal';
import ServiceConnectionModal from '@/components/modals/ServiceConnectionModal';
import { isIntegrationVisible } from '@/lib/config/integrations';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface ServiceConnection {
  id: string;
  provider: string;
  status: string;
  service_data: any;
  created_at: string;
  updated_at?: string;
  last_sync_at?: string;
}

interface Service {
  id: string;
  name: string;
  icon: string;
  connected: boolean;
  status: string;
  description: string;
  connection?: ServiceConnection;
}

interface ServiceSettingsProps {
  projectId: string;
  projectName?: string;
}

export function ServiceSettings({ projectId, projectName }: ServiceSettingsProps) {
  // Provider whose access token is being set up (was a global-settings tab; now
  // done inline here, where the missing token actually blocks a connection).
  const [tokenSetupProvider, setTokenSetupProvider] = useState<'github' | 'supabase' | 'vercel' | null>(null);
  const [tokenStatus, setTokenStatus] = useState<{
    github: boolean | null;
    supabase: boolean | null;
    vercel: boolean | null;
  }>({
    github: null,
    supabase: null,
    vercel: null
  });
  const [services, setServices] = useState<Service[]>([
    {
      id: 'github',
      name: 'Git',
      icon: 'github',
      connected: false,
      status: 'disconnected',
      description: 'Connect a Git repository to push code and deploy'
    },
    {
      id: 'vercel',
      name: 'Vercel',
      icon: 'vercel',
      connected: false,
      status: 'disconnected',
      description: 'Deploy your project to Vercel for production hosting'
    },
    {
      id: 'supabase',
      name: 'Supabase',
      icon: 'supabase',
      connected: false,
      status: 'disconnected',
      description: 'Connect to Supabase for backend services and database'
    }
  ].filter(service => isIntegrationVisible(service.id)));
  
  const [gitHubModalOpen, setGitHubModalOpen] = useState(false);
  const [vercelModalOpen, setVercelModalOpen] = useState(false);
  const [supabaseModalOpen, setSupabaseModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Per-project git settings: the branch the project operates on (push target
  // + sync source) and the state of the manual "Sync" (pull) action.
  const [branchInput, setBranchInput] = useState('');
  // Once the user edits the field, stop overwriting it with the server value on
  // reload (Sync/connect-modal close call loadServiceConnections) — otherwise
  // their unsaved typing silently reverts.
  const branchDirty = useRef(false);
  const [branchSaving, setBranchSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [gitStatusMessage, setGitStatusMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // Background auto-sync: periodic pull of the operating branch. Interval field
  // is dirty-tracked like the branch so a reload can't wipe in-progress typing.
  const [autoSync, setAutoSync] = useState(false);
  const [autoSyncMinutes, setAutoSyncMinutes] = useState(5);
  const autoSyncMinutesDirty = useRef(false);
  const [autoSyncSaving, setAutoSyncSaving] = useState(false);

  const getProviderIcon = (provider: string) => {
    switch (provider) {
      case 'github':
        return (
          <svg width="16" height="16" viewBox="0 0 98 96" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fillRule="evenodd" clipRule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="currentColor"/>
          </svg>
        );
      case 'supabase':
        return (
          <svg width="16" height="16" viewBox="0 0 109 113" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z" fill="url(#paint0_linear)"/>
            <path d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922 -2.92775 62.8321 2.1655 56.4175L45.317 2.07103Z" fill="#3ECF8E"/>
            <defs>
              <linearGradient id="paint0_linear" x1="53.9738" y1="54.974" x2="94.1635" y2="71.8295" gradientUnits="userSpaceOnUse">
                <stop stopColor="#249361"/>
                <stop offset="1" stopColor="#3ECF8E"/>
              </linearGradient>
            </defs>
          </svg>
        );
      case 'vercel':
        return (
          <svg width="16" height="16" viewBox="0 0 76 65" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" fill="currentColor"/>
          </svg>
        );
      default:
        return null;
    }
  };

  // Load service connections from API
  const loadServiceConnections = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/services`);
      if (!response.ok) return;
      
      const connections: ServiceConnection[] = await response.json();
      
      // Update services with connection status
      setServices(prev => prev.map(service => {
        const connection = connections.find(conn => conn.provider === service.id);
        return {
          ...service,
          connected: !!connection,
          status: connection?.status || 'disconnected',
          connection,
        };
      }));

      const github = connections.find(conn => conn.provider === 'github');
      if (github && !branchDirty.current) {
        setBranchInput(github.service_data?.branch || github.service_data?.default_branch || 'main');
      }
      if (github) {
        setAutoSync(github.service_data?.auto_sync === true);
        if (!autoSyncMinutesDirty.current) {
          setAutoSyncMinutes(Number(github.service_data?.auto_sync_interval_minutes) || 5);
        }
      }
    } catch (error) {
      console.error('Failed to load service connections:', error);
    }
  }, [projectId]);

  const handleSaveBranch = async () => {
    setBranchSaving(true);
    setGitStatusMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/github/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: branchInput }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || 'Failed to save branch');
      }
      setGitStatusMessage({ kind: 'ok', text: `Operating branch set to "${body.branch}"` });
      branchDirty.current = false; // saved value is now canonical again
      loadServiceConnections();
    } catch (error) {
      setGitStatusMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to save branch' });
    } finally {
      setBranchSaving(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setGitStatusMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/github/pull`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || 'Sync failed');
      }
      if (body.preview_error) {
        // Sync succeeded but the preview couldn't come back up — surface it as
        // an error so the user knows their preview is down.
        setGitStatusMessage({ kind: 'error', text: `${body.message}, but the preview failed to restart: ${body.preview_error}` });
      } else {
        setGitStatusMessage({
          kind: 'ok',
          text: body.message + (body.preview_restarted ? ' — preview restarted' : ''),
        });
      }
      loadServiceConnections();
    } catch (error) {
      setGitStatusMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Sync failed' });
    } finally {
      setSyncing(false);
    }
  };

  // Persist the auto-sync toggle and/or interval. `nextEnabled` lets the toggle
  // save the new value immediately (state updates are async).
  const saveAutoSync = async (nextEnabled: boolean, nextMinutes: number) => {
    setAutoSyncSaving(true);
    setGitStatusMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/github/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_sync: nextEnabled, auto_sync_interval_minutes: nextMinutes }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || 'Failed to update auto-sync');
      setAutoSync(body.auto_sync === true);
      setAutoSyncMinutes(Number(body.auto_sync_interval_minutes) || nextMinutes);
      autoSyncMinutesDirty.current = false;
      setGitStatusMessage({
        kind: 'ok',
        text: body.auto_sync
          ? `Auto-sync on — pulling ${body.branch || branchInput || 'the branch'} every ${body.auto_sync_interval_minutes} min`
          : 'Auto-sync off',
      });
    } catch (error) {
      setGitStatusMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to update auto-sync' });
    } finally {
      setAutoSyncSaving(false);
    }
  };

  // Check if tokens exist for all services. Each probe fails independently —
  // one transient error must not mark ALL providers "Token needed".
  const checkTokens = useCallback(async () => {
    const probe = (provider: string) =>
      fetch(`${API_BASE}/api/tokens/${provider}`).then(r => r.ok).catch(() => false);
    const [github, supabase, vercel] = await Promise.all([
      probe('github'), probe('supabase'), probe('vercel'),
    ]);
    setTokenStatus({ github, supabase, vercel });
  }, []);

  // Load connections and check tokens on mount
  useEffect(() => {
    loadServiceConnections();
    checkTokens();
  }, [loadServiceConnections, checkTokens]);

  const handleConnect = async (serviceId: string) => {
    if (serviceId === 'github') {
      setGitHubModalOpen(true);
      return;
    }
    
    if (serviceId === 'vercel') {
      setVercelModalOpen(true);
      return;
    }
    
    if (serviceId === 'supabase') {
      setSupabaseModalOpen(true);
      return;
    }
    
    // For other services, show placeholder
    alert(`${serviceId} integration not implemented yet.`);
  };

  const handleGitHubModalSuccess = () => {
    loadServiceConnections(); // Reload connections after GitHub connection
    // Notify other components that services have been updated
    window.dispatchEvent(new CustomEvent('services-updated'));
  };

  const handleVercelModalSuccess = () => {
    loadServiceConnections(); // Reload connections after Vercel connection
    // Notify other components that services have been updated
    window.dispatchEvent(new CustomEvent('services-updated'));
  };

  const handleSupabaseModalSuccess = () => {
    loadServiceConnections(); // Reload connections after Supabase connection
    // Notify other components that services have been updated
    window.dispatchEvent(new CustomEvent('services-updated'));
  };

  const handleDisconnect = async (serviceId: string) => {
    if (!confirm(`Disconnect from ${serviceId}?`)) return;
    
    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/services/${serviceId}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        loadServiceConnections(); // Reload connections
      } else {
        alert(`Failed to disconnect from ${serviceId}`);
      }
    } catch (error) {
      console.error(`Error disconnecting from ${serviceId}:`, error);
      alert(`Failed to disconnect from ${serviceId}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50 mb-4">
          Service Integrations
        </h3>

        <div className="space-y-4">
          {services.map(service => (
            <div
              key={service.id}
              className="relative group overflow-hidden rounded-2xl border border-gray-200 dark:border-white/8 bg-white dark:bg-white/3 backdrop-blur-sm supports-backdrop-filter:bg-white/60 transition-all duration-200 hover:shadow-lg"
            >
              <div className="absolute inset-x-0 -top-px h-px bg-linear-to-r from-transparent via-gray-200 to-transparent" />
              <div className="p-5 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6 justify-between">
                <div className="flex items-center gap-4 flex-1 min-w-0">
                  <div className="w-10 h-10 rounded-xl ring-1 ring-inset ring-gray-200 dark:ring-white/8 bg-gray-50 dark:bg-white/6 text-gray-700 dark:text-gray-200 flex items-center justify-center">
                    {getProviderIcon(service.icon)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-3 mb-1 min-w-0">
                      <h4 className="text-[15px] font-semibold tracking-tight text-gray-900 dark:text-gray-50 ">
                        {service.name}
                      </h4>
                      {service.connected && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium text-emerald-700 bg-emerald-100 whitespace-nowrap">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          Connected
                        </span>
                      )}
                      {!service.connected && tokenStatus[service.id as keyof typeof tokenStatus] === false && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium text-amber-700 bg-amber-100 whitespace-nowrap">
                          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd"/></svg>
                          Token needed
                        </span>
                      )}
                    </div>

                    <div className="text-sm leading-6 text-gray-600 dark:text-gray-300 min-w-0">
                      {!service.connected ? null : (
                        <div className="text-gray-700 dark:text-gray-200 ">
                          {service.id === 'github' && service.connection?.service_data?.repo_url ? (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <span className="shrink-0">Repository:</span>
                                <a
                                  href={service.connection.service_data.repo_url}
                                  target="_blank" rel="noopener noreferrer"
                                  className="truncate font-mono text-brand-500 hover:underline"
                                >
                                  {service.connection.service_data.repo_name || service.connection.service_data.repo_url}
                                </a>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="shrink-0">Branch:</span>
                                <input
                                  value={branchInput}
                                  onChange={(e) => { branchDirty.current = true; setBranchInput(e.target.value); }}
                                  spellCheck={false}
                                  className="w-36 px-2 py-1 text-sm font-mono rounded-lg border border-gray-300 dark:border-white/12 bg-white dark:bg-white/6 text-gray-800 dark:text-gray-100 focus:outline-hidden focus:ring-1 focus:ring-brand-500"
                                />
                                <button
                                  onClick={handleSaveBranch}
                                  disabled={branchSaving || !branchInput.trim() || branchInput.trim() === (service.connection.service_data.branch || service.connection.service_data.default_branch || 'main')}
                                  className="px-3 py-1 text-xs rounded-lg border border-gray-300 dark:border-white/12 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/6 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  {branchSaving ? 'Saving…' : 'Save'}
                                </button>
                                <button
                                  onClick={handleSync}
                                  disabled={syncing}
                                  className="px-3 py-1 text-xs rounded-lg bg-brand-500 hover:bg-brand-600 text-white disabled:opacity-50 flex items-center gap-1.5"
                                  title="Pull the latest changes from the branch into this project (restarts the preview when something changed)"
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className={syncing ? 'animate-spin' : ''}>
                                    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                  </svg>
                                  {syncing ? 'Syncing…' : 'Sync'}
                                </button>
                              </div>
                              {/* Auto-sync: background pull of the operating branch on a cadence. */}
                              <div className="flex flex-wrap items-center gap-2">
                                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                                  <input
                                    type="checkbox"
                                    checked={autoSync}
                                    disabled={autoSyncSaving}
                                    onChange={(e) => saveAutoSync(e.target.checked, autoSyncMinutes)}
                                    className="h-4 w-4 rounded-sm border-gray-300 dark:border-white/20 text-brand-500 focus:ring-brand-500 accent-brand-500"
                                  />
                                  <span className="shrink-0">Auto-sync from remote</span>
                                </label>
                                {autoSync && (
                                  <span className="flex items-center gap-1.5">
                                    <span className="text-gray-500 dark:text-gray-400">every</span>
                                    <input
                                      type="number"
                                      min={1}
                                      max={1440}
                                      value={autoSyncMinutes}
                                      disabled={autoSyncSaving}
                                      onChange={(e) => { autoSyncMinutesDirty.current = true; setAutoSyncMinutes(Number(e.target.value)); }}
                                      className="w-16 px-2 py-1 text-sm font-mono rounded-lg border border-gray-300 dark:border-white/12 bg-white dark:bg-white/6 text-gray-800 dark:text-gray-100 focus:outline-hidden focus:ring-1 focus:ring-brand-500"
                                    />
                                    <span className="text-gray-500 dark:text-gray-400">min</span>
                                    <button
                                      onClick={() => saveAutoSync(true, Math.min(1440, Math.max(1, Math.round(autoSyncMinutes) || 5)))}
                                      disabled={autoSyncSaving || !autoSyncMinutesDirty.current}
                                      className="px-3 py-1 text-xs rounded-lg border border-gray-300 dark:border-white/12 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/6 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                      {autoSyncSaving ? 'Saving…' : 'Save'}
                                    </button>
                                  </span>
                                )}
                              </div>
                              {gitStatusMessage && (
                                <p className={`text-xs ${gitStatusMessage.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                                  {gitStatusMessage.text}
                                </p>
                              )}
                            </div>
                          ) : service.id === 'vercel' && service.connection?.service_data?.project_url ? (
                            <div className="flex items-center gap-2">
                              <span className="shrink-0">Project:</span>
                              <a 
                                href={service.connection.service_data.project_url}
                                target="_blank" rel="noopener noreferrer"
                                className="truncate font-mono text-brand-500 hover:underline"
                              >
                                {service.connection.service_data.project_name || service.connection.service_data.project_url}
                              </a>
                            </div>
                          ) : service.id === 'supabase' && service.connection?.service_data?.project_url ? (
                            <div className="flex items-center gap-2">
                              <span className="shrink-0">Project:</span>
                              <a 
                                href={service.connection.service_data.project_url}
                                target="_blank" rel="noopener noreferrer"
                                className="truncate font-mono text-brand-500 hover:underline"
                              >
                                {service.connection.service_data.project_name || service.connection.service_data.project_id}
                              </a>
                            </div>
                          ) : (
                            <span>Connected and ready to use</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 sm:shrink-0 w-full sm:w-auto sm:justify-end">
                    {service.connected ? (
                      <button
                        onClick={() => handleDisconnect(service.id)}
                        className="px-4 py-2 text-sm rounded-xl text-red-600 hover:text-red-700 border border-transparent hover:border-red-200 hover:bg-red-50 transition whitespace-nowrap w-full sm:w-auto"
                        disabled={isLoading}
                      >
                        Disconnect
                      </button>
                    ) : tokenStatus[service.id as keyof typeof tokenStatus] === false ? (
                      <button
                        onClick={() => setTokenSetupProvider(service.id as 'github' | 'supabase' | 'vercel')}
                        className="px-4 py-2.5 text-sm rounded-xl bg-amber-500 hover:bg-amber-600 text-white shadow-xs transition flex items-center justify-center gap-2 whitespace-nowrap w-full sm:w-auto"
                        disabled={isLoading}
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd"/></svg>
                        Setup Token
                      </button>
                    ) : (
                      <button
                        onClick={() => handleConnect(service.id)}
                        className="px-4 py-2.5 text-sm rounded-xl bg-brand-500 hover:bg-brand-600 text-white shadow-xs transition disabled:opacity-50 whitespace-nowrap w-full sm:w-auto"
                        disabled={isLoading || tokenStatus[service.id as keyof typeof tokenStatus] === null}
                      >
                        {tokenStatus[service.id as keyof typeof tokenStatus] === null ? 'Checking...' : 'Connect'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* GitHub Repository Modal */}
      {gitHubModalOpen && (
        <GitHubRepoModal
          isOpen={gitHubModalOpen}
          onClose={() => setGitHubModalOpen(false)}
          projectId={projectId}
          projectName={projectName || projectId}
          onSuccess={handleGitHubModalSuccess}
        />
      )}

      {/* Vercel Project Modal */}
      {vercelModalOpen && (
        <VercelProjectModal
          isOpen={vercelModalOpen}
          onClose={() => setVercelModalOpen(false)}
          projectId={projectId}
          projectName={projectName || projectId}
          onSuccess={handleVercelModalSuccess}
        />
      )}

      {/* Supabase Project Modal */}
      {supabaseModalOpen && (
        <SupabaseModal
          isOpen={supabaseModalOpen}
          onClose={() => setSupabaseModalOpen(false)}
          projectId={projectId}
          projectName={projectName || projectId}
          onSuccess={handleSupabaseModalSuccess}
        />
      )}

      {/* Access-token setup (relocated from the removed global Services tab). */}
      {tokenSetupProvider && (
        <ServiceConnectionModal
          isOpen={!!tokenSetupProvider}
          onClose={() => { setTokenSetupProvider(null); checkTokens(); }}
          provider={tokenSetupProvider}
        />
      )}
    </div>
  );
}
