"use client";
import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { responseErrorMessage } from '@/lib/client/api-error';
import { useT } from '@/contexts/I18nContext';
import type { MessageKey } from '@/lib/i18n/messages/en';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface ServiceConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  provider: 'github' | 'supabase' | 'vercel';
  projectId?: string;
}

const GITHUB_STEPS = [
  'settings.modal.token.gh1', 'settings.modal.token.gh2', 'settings.modal.token.stepName', 'settings.modal.token.gh4',
  'settings.modal.token.gh5', 'settings.modal.token.gh6', 'settings.modal.token.stepPaste',
] as const satisfies readonly MessageKey[];
const SUPABASE_STEPS = [
  'settings.modal.token.sb1', 'settings.modal.token.sb2', 'settings.modal.token.stepName', 'settings.modal.token.sb4',
  'settings.modal.token.sb5', 'settings.modal.token.stepPaste',
] as const satisfies readonly MessageKey[];
const VERCEL_STEPS = [
  'settings.modal.token.vc1', 'settings.modal.token.vc2', 'settings.modal.token.stepName', 'settings.modal.token.vc4',
  'settings.modal.token.vc5', 'settings.modal.token.vc6', 'settings.modal.token.stepPaste',
] as const satisfies readonly MessageKey[];

interface ServiceToken {
  id: string;
  provider: string;
  token: string;
  name?: string;
  created_at: string;
  last_used?: string;
}

export default function ServiceConnectionModal({ 
  isOpen, 
  onClose, 
  provider,
  projectId 
}: ServiceConnectionModalProps) {
  const t = useT();
  const [isLoading, setIsLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [token, setToken] = useState('');
  const [savedToken, setSavedToken] = useState<ServiceToken | null>(null);
  const [showTokenInput, setShowTokenInput] = useState(false);
  // Inline result/error line (replaces alert()s that dumped raw JSON).
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const loadSavedToken = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/tokens/${provider}`);
      if (response.ok) {
        const tokenData = await response.json();
        setSavedToken(tokenData);
      } else {
        setSavedToken(null);
      }
    } catch (error) {
      console.error('Failed to load saved token:', error);
      setSavedToken(null);
    }
  }, [provider]);

  // Load saved token on mount
  useEffect(() => {
    if (isOpen) {
      loadSavedToken();
    }
  }, [isOpen, loadSavedToken]);

  const handleSaveToken = async () => {
    if (!token.trim()) {
      setNotice({ kind: 'error', text: t('settings.modal.token.enterValid') });
      return;
    }

    setIsLoading(true);
    setNotice(null);
    try {
      const response = await fetch(`${API_BASE}/api/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          token: token.trim(),
          name: `${provider.charAt(0).toUpperCase() + provider.slice(1)} Token`
        })
      });
      
      if (response.ok) {
        // POST /api/tokens answers { success, data: record }.
        const body = await response.json().catch(() => null);
        const record = body && typeof body === 'object' && 'data' in body ? body.data : body;
        if (record?.id) {
          // Never keep the plaintext token around in client state.
          setSavedToken({ ...record, token: '' });
        } else {
          await loadSavedToken();
        }
        setToken('');
        setShowTokenInput(false);
        setNotice({ kind: 'ok', text: t('settings.modal.token.saved') });
      } else {
        setNotice({ kind: 'error', text: await responseErrorMessage(response, t('settings.modal.token.saveFailed')) });
      }
    } catch (error) {
      console.error('Failed to save token:', error);
      setNotice({ kind: 'error', text: t('settings.modal.token.saveNetwork') });
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteToken = async () => {
    if (!savedToken || !confirm(t('settings.modal.token.confirmDelete'))) {
      return;
    }
    
    setIsLoading(true);
    setNotice(null);
    try {
      const response = await fetch(`${API_BASE}/api/tokens/${savedToken.id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        setSavedToken(null);
        setNotice({ kind: 'ok', text: t('settings.modal.token.deleted') });
      } else {
        setNotice({ kind: 'error', text: await responseErrorMessage(response, t('settings.modal.token.deleteFailed')) });
      }
    } catch (error) {
      console.error('Failed to delete token:', error);
      setNotice({ kind: 'error', text: t('settings.modal.token.deleteNetwork') });
    } finally {
      setIsLoading(false);
    }
  };

  // Service-specific actions using saved tokens
  const handleGitHubAction = async (action: string) => {
    if (!savedToken || !projectId) return;
    
    setActionLoading(true);
    try {
      if (action === 'create-repo') {
        const response = await fetch(`${API_BASE}/api/github/create-repo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token_id: savedToken.id,
            repo_name: `cc-lovable-${projectId}`,
            private: false
          })
        });
        
        if (response.ok) {
          const data = await response.json();
          setNotice({ kind: 'ok', text: t('settings.modal.token.repoCreated', { url: data.html_url }) });
        } else {
          setNotice({ kind: 'error', text: await responseErrorMessage(response, t('settings.modal.token.repoFailed')) });
        }
      }
    } catch (error) {
      console.error('GitHub action failed:', error);
      setNotice({ kind: 'error', text: t('settings.modal.token.actionFailed', { name: 'GitHub' }) });
    } finally {
      setActionLoading(false);
    }
  };

  const handleSupabaseAction = async (action: string) => {
    if (!savedToken || !projectId) return;
    
    setActionLoading(true);
    try {
      if (action === 'create-project') {
        const dbPass = prompt(t('settings.modal.token.dbPassPrompt'));
        if (!dbPass) return;
        
        const response = await fetch(`${API_BASE}/api/supabase/create-project`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token_id: savedToken.id,
            project_id: projectId,
            project_name: `cc-lovable-${projectId}`,
            db_pass: dbPass,
            region: 'us-east-1'
          })
        });
        
        if (response.ok) {
          const data = await response.json();
          setNotice({ kind: 'ok', text: t('settings.modal.token.supabaseCreated', { name: data.name }) });
        } else {
          setNotice({ kind: 'error', text: await responseErrorMessage(response, t('settings.modal.token.projectFailed')) });
        }
      }
    } catch (error) {
      console.error('Supabase action failed:', error);
      setNotice({ kind: 'error', text: t('settings.modal.token.actionFailed', { name: 'Supabase' }) });
    } finally {
      setActionLoading(false);
    }
  };

  const handleVercelAction = async (action: string) => {
    if (!savedToken || !projectId) return;
    
    setActionLoading(true);
    try {
      if (action === 'deploy') {
        const response = await fetch(`${API_BASE}/api/projects/${projectId}/vercel/deploy`, {
          method: 'POST'
        });
        
        if (response.ok) {
          const data = await response.json();
          const deploymentUrl = data.deployment_url ?? data.url ?? null;
          const status = data.status ?? 'queued';
          if (deploymentUrl) {
            const formatted = deploymentUrl.startsWith('http') ? deploymentUrl : `https://${deploymentUrl}`;
            setNotice({ kind: 'ok', text: t('settings.modal.token.deployUrl', { status, url: formatted }) });
          } else {
            setNotice({ kind: 'ok', text: t('settings.modal.token.deployStatus', { status }) });
          }
        } else {
          setNotice({ kind: 'error', text: await responseErrorMessage(response, t('settings.modal.token.deployFailed')) });
        }
      }
    } catch (error) {
      console.error('Vercel action failed:', error);
      setNotice({ kind: 'error', text: t('settings.modal.token.actionFailed', { name: 'Vercel' }) });
    } finally {
      setActionLoading(false);
    }
  };

  const steps = (keys: readonly MessageKey[]) => keys.map((k) => t(k));

  const getProviderInfo = () => {
    switch (provider) {
      case 'github':
        return {
          title: 'GitHub',
          description: t('settings.modal.token.githubDesc'),
          tokenUrl: 'https://github.com/settings/tokens',
          tokenName: t('settings.modal.token.pat'),
          icon: (
            <svg width="32" height="32" viewBox="0 0 98 96" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path fillRule="evenodd" clipRule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="currentColor"/>
            </svg>
          ),
          instructions: steps(GITHUB_STEPS),
          actions: ['create-repo']
        };
      case 'supabase':
        return {
          title: 'Supabase',
          description: t('settings.modal.token.supabaseDesc'),
          tokenUrl: 'https://supabase.com/dashboard/account/tokens',
          tokenName: t('settings.modal.token.pat'),
          icon: (
            <svg width="32" height="32" viewBox="0 0 109 113" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z" fill="url(#paint0_linear)"/>
              <path d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922 -2.92775 62.8321 2.1655 56.4175L45.317 2.07103Z" fill="#3ECF8E"/>
              <defs>
                <linearGradient id="paint0_linear" x1="53.9738" y1="54.974" x2="94.1635" y2="71.8295" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#249361"/>
                  <stop offset="1" stopColor="#3ECF8E"/>
                </linearGradient>
              </defs>
            </svg>
          ),
          instructions: steps(SUPABASE_STEPS),
          actions: ['create-project']
        };
      case 'vercel':
        return {
          title: 'Vercel',
          description: t('settings.modal.token.vercelDesc'),
          tokenUrl: 'https://vercel.com/account/tokens',
          tokenName: t('settings.modal.token.apiToken'),
          icon: (
            <svg width="32" height="32" viewBox="0 0 76 65" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" fill="currentColor"/>
            </svg>
          ),
          instructions: steps(VERCEL_STEPS),
          actions: ['deploy']
        };
    }
  };

  const providerInfo = getProviderInfo();

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div
        key={`service-modal-${provider}`}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div 
          className="absolute inset-0 bg-black/50 backdrop-blur-xs"
          onClick={onClose}
        />
        
        <div role="dialog" aria-modal="true" aria-labelledby="service-token-modal-title" className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90dvh] overflow-auto">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
          >
          {/* Header */}
          <div className="p-6 border-b border-gray-200 dark:border-gray-700 ">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="text-gray-700 dark:text-gray-200 ">
                  {providerInfo.icon}
                </div>
                <div>
                  <h2 id="service-token-modal-title" className="text-xl font-semibold text-gray-900 dark:text-gray-50 ">
                    {providerInfo.title} {providerInfo.tokenName}
                  </h2>
                  <p className="text-sm text-gray-600 dark:text-gray-300 ">
                    {providerInfo.description}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label={t('settings.modal.close')}
                className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 "
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="p-6 space-y-6">
            {notice && (
              <div
                role={notice.kind === 'error' ? 'alert' : 'status'}
                className={`flex items-start justify-between gap-3 text-xs rounded-lg px-3 py-2 border ${
                  notice.kind === 'error'
                    ? 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
                    : 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800'
                }`}
              >
                <span className="wrap-break-word min-w-0">{notice.text}</span>
                <button onClick={() => setNotice(null)} className="shrink-0 opacity-70 hover:opacity-100" aria-label={t('settings.modal.dismiss')}>✕</button>
              </div>
            )}
            {savedToken ? (
              // Token is saved - show connection status and actions
              <div className="space-y-4">
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                    <span className="text-sm font-medium text-green-700 ">
                      {t('settings.modal.token.connected')}
                    </span>
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-300 ">
                    <p>{t('settings.modal.token.name', { name: savedToken.name ?? '' })}</p>
                    <p>{t('settings.modal.token.provider', { provider: savedToken.provider })}</p>
                    <p className="text-xs mt-1">{t('settings.modal.token.added', { date: new Date(savedToken.created_at).toLocaleString() })}</p>
                    {savedToken.last_used && (
                      <p className="text-xs">{t('settings.modal.token.lastUsed', { date: new Date(savedToken.last_used).toLocaleString() })}</p>
                    )}
                  </div>
                </div>

                {/* Service Actions */}
                {projectId && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200 ">{t('settings.modal.token.actions')}</h3>
                    {provider === 'github' && (
                      <button
                        onClick={() => handleGitHubAction('create-repo')}
                        disabled={actionLoading}
                        className="w-full px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                      >
                        {actionLoading ? t('settings.modal.token.creatingRepo') : t('settings.modal.token.createRepo')}
                      </button>
                    )}
                    {provider === 'supabase' && (
                      <button
                        onClick={() => handleSupabaseAction('create-project')}
                        disabled={actionLoading}
                        className="w-full px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                      >
                        {actionLoading ? t('settings.modal.token.creatingProject') : t('settings.modal.token.createSupabase')}
                      </button>
                    )}
                    {provider === 'vercel' && (
                      <button
                        onClick={() => handleVercelAction('deploy')}
                        disabled={actionLoading}
                        className="w-full px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                      >
                        {actionLoading ? t('settings.modal.token.deploying') : t('settings.modal.token.deployVercel')}
                      </button>
                    )}
                  </div>
                )}

                {!showTokenInput ? (
                  <div key="actions" className="flex gap-2">
                    <button
                      onClick={() => setShowTokenInput(true)}
                      className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      {t('settings.modal.token.update')}
                    </button>
                    <button
                      onClick={handleDeleteToken}
                      disabled={isLoading}
                      className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      {isLoading ? t('settings.modal.token.deleting') : t('settings.modal.token.delete')}
                    </button>
                  </div>
                ) : (
                  <div key="edit-token" className="space-y-4">
                    <div>
                      <label htmlFor="service-token-new" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
                        {t('settings.modal.token.enterNew', { provider: providerInfo.title, token: providerInfo.tokenName })}
                      </label>
                      <input
                        id="service-token-new"
                        type="password"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder={t('settings.modal.token.pasteNew', { token: providerInfo.tokenName })}
                        className="w-full px-4 py-3 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-50 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm transition-colors"
                        disabled={isLoading}
                        autoFocus
                      />
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                        {t('settings.modal.token.replaceHint')}
                      </p>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setShowTokenInput(false);
                          setToken('');
                        }}
                        className="flex-1 px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg text-sm font-medium transition-colors"
                        disabled={isLoading}
                      >
                        {t('settings.modal.cancel')}
                      </button>
                      <button
                        onClick={handleSaveToken}
                        disabled={isLoading || !token.trim()}
                        className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isLoading ? t('settings.modal.token.updating') : t('settings.modal.token.update')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              // No token saved - show setup instructions and token input
              <div className="space-y-6">
                <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-gray-900 dark:text-gray-50 mb-2">
                    {t('settings.modal.token.setupTitle')}
                  </h3>
                  <p className="text-xs text-gray-700 dark:text-gray-200 mb-3">
                    {t('settings.modal.token.setupIntro', { provider: providerInfo.title, token: providerInfo.tokenName })}
                  </p>
                  <a
                    href={providerInfo.tokenUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-500 font-medium"
                  >
                    {t('settings.modal.token.openSettings', { provider: providerInfo.title })}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </a>
                </div>

                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-3">
                    {t('settings.modal.token.guide')}
                  </h4>
                  <ol className="text-xs text-gray-600 dark:text-gray-300 space-y-2">
                    {providerInfo.instructions.map((step, index) => (
                      <li key={step} className="flex gap-2">
                        <span className="shrink-0 w-5 h-5 bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-50 rounded-full flex items-center justify-center text-xs font-medium">
                          {index + 1}
                        </span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                {/* Token Input Section - Always Visible */}
                <div className="space-y-4">
                  <div>
                    <label htmlFor="service-token-input" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
                      {t('settings.modal.token.enter', { provider: providerInfo.title, token: providerInfo.tokenName })}
                    </label>
                    <input
                      id="service-token-input"
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder={t('settings.modal.token.paste', { token: providerInfo.tokenName })}
                      className="w-full px-4 py-3 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-50 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm transition-colors"
                      disabled={isLoading}
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                      {t('settings.modal.token.encryptedHint')}
                    </p>
                  </div>

                  <button
                    onClick={handleSaveToken}
                    disabled={isLoading || !token.trim()}
                    className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-all duration-200 shadow-xs hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isLoading ? t('settings.modal.token.saving') : t('settings.modal.token.save')}
                  </button>
                </div>
              </div>
            )}
          </div>
          </motion.div>
        </div>
      </div>
    </AnimatePresence>
  );
}
