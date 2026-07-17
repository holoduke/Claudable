"use client";
import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { AnimatePresence } from 'framer-motion';
import { MotionDiv } from '@/lib/motion';
import UsersSettings from '@/components/settings/UsersSettings';
import SystemOverviewSettings from '@/components/settings/SystemOverviewSettings';
import SharedMcpSettings from '@/components/settings/SharedMcpSettings';
import PluginSettings from '@/components/settings/PluginSettings';
import ClaudeAccountSettings from '@/components/settings/ClaudeAccountSettings';
import MyAccountSettings from '@/components/settings/MyAccountSettings';
import BrandWordmark from '@/components/ui/BrandWordmark';
import { FaCog } from 'react-icons/fa';
import { useGlobalSettings } from '@/contexts/GlobalSettingsContext';
import { useI18n } from '@/contexts/I18nContext';
import { getModelDefinitionsForCli, normalizeModelId } from '@/lib/constants/cliModels';
import { fetchCliStatusSnapshot, createCliStatusFallback } from '@/hooks/useCLI';
import type { CLIStatus } from '@/types/cli';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

type SettingsTab = 'general' | 'ai-agents' | 'claude' | 'account' | 'users' | 'shared-mcp' | 'plugins' | 'system' | 'about';

interface GlobalSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: SettingsTab;
}

interface CurrentUser {
  id: string;
  email: string;
  role: 'admin' | 'user';
  itopsEnabled?: boolean;
}

interface CLIOption {
  id: string;
  name: string;
  icon: string;
  description: string;
  models: { id: string; name: string; }[];
  color: string;
  brandColor: string;
  downloadUrl: string;
  installCommand: string;
  enabled?: boolean;
}

const CLI_OPTIONS: CLIOption[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    icon: '',
    description: 'Anthropic Claude with advanced reasoning',
    color: 'from-orange-500 to-red-600',
    brandColor: '#DE7356',
    downloadUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    enabled: true,
    models: getModelDefinitionsForCli('claude').map(({ id, name }) => ({ id, name })),
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    icon: '',
    description: 'OpenAI Codex agent with GPT-5 support',
    color: 'from-slate-900 to-gray-700',
    brandColor: '#000000',
    downloadUrl: 'https://github.com/openai/codex',
    installCommand: 'npm install -g @openai/codex',
    enabled: true,
    models: getModelDefinitionsForCli('codex').map(({ id, name }) => ({ id, name })),
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    icon: '',
    description: 'Cursor CLI with multi-model router and autonomous tooling',
    color: 'from-slate-500 to-gray-600',
    brandColor: '#6B7280',
    downloadUrl: 'https://docs.cursor.com/en/cli/overview',
    installCommand: 'curl https://cursor.com/install -fsS | bash',
    enabled: true,
    models: getModelDefinitionsForCli('cursor').map(({ id, name }) => ({ id, name })),
  },
  {
    id: 'qwen',
    name: 'Qwen Coder',
    icon: '',
    description: 'Alibaba Qwen Code CLI with sandbox capabilities',
    color: 'from-emerald-500 to-teal-600',
    brandColor: '#11A97D',
    downloadUrl: 'https://github.com/QwenLM/qwen-code',
    installCommand: 'npm install -g @qwen-code/qwen-code',
    enabled: true,
    models: getModelDefinitionsForCli('qwen').map(({ id, name }) => ({ id, name })),
  },
  {
    id: 'glm',
    name: 'GLM CLI',
    icon: '',
    description: 'Zhipu GLM agent running on Claude Code runtime',
    color: 'from-blue-500 to-indigo-600',
    brandColor: '#1677FF',
    downloadUrl: 'https://docs.z.ai/devpack/tool/claude',
    installCommand: 'zai devpack install claude',
    enabled: true,
    models: getModelDefinitionsForCli('glm').map(({ id, name }) => ({ id, name })),
  },
];

// Global settings are provided by context

export default function GlobalSettings({ isOpen, onClose, initialTab = 'general' }: GlobalSettingsProps) {
  const { locale, setLocale, locales, t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [authOff, setAuthOff] = useState(false);
  const [authConfigLoaded, setAuthConfigLoaded] = useState(false);
  const [userLoaded, setUserLoaded] = useState(false);
  const [cliStatus, setCLIStatus] = useState<CLIStatus>({});
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const { settings: globalSettings, setSettings: setGlobalSettings, refresh: refreshGlobalSettings } = useGlobalSettings();
  const [isLoading, setIsLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [selectedCLI, setSelectedCLI] = useState<CLIOption | null>(null);
  const [apiKeyVisibility, setApiKeyVisibility] = useState<Record<string, boolean>>({});

  // Show toast function. Memoized so it has a stable identity — it's passed to
  // UsersSettings, whose data-loading effect depends on it; an unstable ref
  // would re-fire that effect (and re-fetch users) on every parent re-render.
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const loadGlobalSettings = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/settings/global`);
      if (response.ok) {
        const settings = await response.json();
        if (settings?.cli_settings) {
          for (const [cli, config] of Object.entries(settings.cli_settings)) {
            if (config && typeof config === 'object' && 'model' in config) {
              (config as any).model = normalizeModelId(cli, (config as any).model as string);
            }
          }
        }
        setGlobalSettings(settings);
      }
    } catch (error) {
      console.error('Failed to load global settings:', error);
    }
  }, [setGlobalSettings]);

  const checkCLIStatus = useCallback(async () => {
    const checkingStatus: CLIStatus = CLI_OPTIONS.reduce((acc, cli) => {
      acc[cli.id] = { installed: true, checking: true };
      return acc;
    }, {} as CLIStatus);
    setCLIStatus(checkingStatus);

    try {
      const status = await fetchCliStatusSnapshot();
      setCLIStatus(status);
    } catch (error) {
      console.error('Error checking CLI status:', error);
      setCLIStatus(createCliStatusFallback());
    }
  }, []);

  const loadCurrentUser = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/users/me`);
      if (response.ok) {
        const json = await response.json();
        setCurrentUser((json?.data as CurrentUser) ?? null);
      } else {
        setCurrentUser(null);
      }
    } catch {
      setCurrentUser(null);
    } finally {
      setUserLoaded(true);
    }
  }, []);

  const loadAuthConfig = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/config`);
      const json = res.ok ? await res.json() : null;
      setAuthOff(json?.success ? json.data?.authEnabled === false : false);
    } catch {
      setAuthOff(false);
    } finally {
      setAuthConfigLoaded(true);
    }
  }, []);

  // Load all service tokens and CLI data
  useEffect(() => {
    if (isOpen) {
      loadGlobalSettings();
      checkCLIStatus();
      loadCurrentUser();
      loadAuthConfig();
    }
  }, [isOpen, loadGlobalSettings, checkCLIStatus, loadCurrentUser, loadAuthConfig]);

  const isAdmin = currentUser?.role === 'admin';
  // Org-global infra (Shared MCP): manageable by an admin, OR by the local
  // operator when the auth gate is OFF (single-tenant) — the API gates are
  // no-ops then too. Kept separate from `isAdmin` so the user-account tabs
  // (Users) still require a real signed-in admin.
  const canManageOrg = isAdmin || authOff;

  // If a non-admin somehow lands on the Users tab, fall back to General — but
  // only once we actually know who the user is, so an initialTab='users' isn't
  // wrongly redirected during the brief window before /api/users/me resolves.
  useEffect(() => {
    // The shared-mcp guard also waits on authConfigLoaded: canManageOrg depends
    // on authOff, which loads from a SEPARATE fetch than the user. Without this,
    // a single-tenant (auth-off) user opening initialTab='shared-mcp' gets bounced
    // to General if /api/users/me resolves before /api/auth/config.
    if (
      (userLoaded && !isAdmin && (activeTab === 'users' || activeTab === 'system')) ||
      (userLoaded && authConfigLoaded && !canManageOrg && (activeTab === 'shared-mcp' || activeTab === 'plugins'))
    ) {
      setActiveTab('general');
    }
  }, [userLoaded, authConfigLoaded, activeTab, isAdmin, canManageOrg]);

  const saveGlobalSettings = async () => {
    setIsLoading(true);
    setSaveMessage(null);
    
    try {
      const payload = JSON.parse(JSON.stringify(globalSettings));
      if (payload?.cli_settings) {
        for (const [cli, config] of Object.entries(payload.cli_settings)) {
          if (config && typeof config === 'object' && 'model' in config) {
            (config as any).model = normalizeModelId(cli, (config as any).model as string);
          }
        }
      }

      const response = await fetch(`${API_BASE}/api/settings/global`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        throw new Error('Failed to save settings');
      }
      
      setSaveMessage({ 
        type: 'success', 
        text: 'Settings saved successfully!' 
      });
      // make sure context stays in sync
      try {
        await refreshGlobalSettings();
      } catch {}
      
      // Clear message after 3 seconds
      setTimeout(() => setSaveMessage(null), 3000);
      
    } catch (error) {
      console.error('Failed to save global settings:', error);
      setSaveMessage({ 
        type: 'error', 
        text: 'Failed to save settings. Please try again.' 
      });
      
      // Clear error message after 5 seconds
      setTimeout(() => setSaveMessage(null), 5000);
    } finally {
      setIsLoading(false);
    }
  };


  const setDefaultCLI = (cliId: string) => {
    const cliInstalled = cliStatus[cliId]?.installed;
    if (!cliInstalled) return;
    
    setGlobalSettings(prev => ({
      ...prev,
      default_cli: cliId
    }));
  };

  const setDefaultModel = (cliId: string, modelId: string) => {
    setGlobalSettings(prev => ({
      ...prev,
      cli_settings: {
        ...(prev?.cli_settings ?? {}),
        [cliId]: {
          ...(prev?.cli_settings?.[cliId] ?? {}),
          model: normalizeModelId(cliId, modelId)
        }
      }
    }));
  };

  const setCliApiKey = (cliId: string, apiKey: string) => {
    setGlobalSettings(prev => {
      const nextCliSettings = { ...(prev?.cli_settings ?? {}) };
      const existing = { ...(nextCliSettings[cliId] ?? {}) };
      const trimmed = apiKey.trim();

      if (trimmed.length > 0) {
        existing.apiKey = trimmed;
        nextCliSettings[cliId] = existing;
      } else {
        delete existing.apiKey;
        if (Object.keys(existing).length > 0) {
          nextCliSettings[cliId] = existing;
        } else {
          delete nextCliSettings[cliId];
        }
      }

      return {
        ...prev,
        cli_settings: nextCliSettings,
      };
    });
  };

  const toggleApiKeyVisibility = (cliId: string) => {
    setApiKeyVisibility(prev => ({
      ...prev,
      [cliId]: !prev[cliId],
    }));
  };


  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div 
          className="absolute inset-0 bg-black/60 backdrop-blur-md"
          onClick={onClose}
        />
        
        <MotionDiv 
          className="relative bg-white dark:bg-[#12100e] rounded-2xl shadow-2xl w-full max-w-5xl h-[700px] border border-gray-200 dark:border-white/10 flex flex-col"
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.2 }}
        >
          {/* Header */}
          <div className="p-5 border-b border-gray-200 dark:border-white/8">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-gray-600 dark:text-gray-300 ">
                  <FaCog size={18} />
                </span>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-50 ">Global Settings</h2>
              </div>
              <button
                onClick={onClose}
                className="text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition-colors p-1 hover:bg-gray-100 dark:hover:bg-white/6 rounded-lg"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="border-b border-gray-200 dark:border-white/8">
            <nav className="flex px-5">
              {([
                { id: 'general' as const, label: t('settings.tab.general') },
                { id: 'ai-agents' as const, label: t('settings.tab.aiAgents') },
                ...(currentUser ? [{ id: 'claude' as const, label: t('settings.tab.claude') }] : []),
                ...(currentUser ? [{ id: 'account' as const, label: t('settings.tab.account') }] : []),
                ...(isAdmin ? [{ id: 'users' as const, label: t('settings.tab.users') }] : []),
                ...(canManageOrg ? [{ id: 'shared-mcp' as const, label: t('settings.tab.sharedMcp') }] : []),
                ...(canManageOrg ? [{ id: 'plugins' as const, label: t('settings.tab.plugins') }] : []),
                ...(isAdmin ? [{ id: 'system' as const, label: t('settings.tab.system') }] : []),
                { id: 'about' as const, label: t('settings.tab.about') }
              ] as { id: SettingsTab; label: string }[]).map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-all ${
                    activeTab === tab.id
                      ? 'border-brand-500 text-gray-900 dark:text-gray-50 '
                      : 'border-transparent text-gray-600 dark:text-gray-300 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300 dark:hover:border-white/18 '
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Tab Content */}
          <div className="flex-1 p-6 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent">
            {activeTab === 'general' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50 mb-4">{t('settings.general.language')}</h3>
                  <div className="p-4 bg-gray-50 dark:bg-white/3 rounded-xl border border-gray-200 dark:border-white/8">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900 dark:text-gray-50">{t('settings.general.language')}</p>
                        <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t('settings.general.languageDesc')}</p>
                      </div>
                      <select
                        value={locale}
                        onChange={(e) => setLocale(e.target.value as typeof locale)}
                        className="shrink-0 pl-3 pr-8 py-2 text-sm border border-gray-200 dark:border-white/8 rounded-lg bg-white dark:bg-white/6 hover:border-gray-300 dark:hover:border-white/18 text-gray-700 dark:text-gray-200 focus:outline-hidden focus:ring-0 transition-colors cursor-pointer"
                      >
                        {locales.map((l) => (
                          <option key={l.code} value={l.code}>{l.flag} {l.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
                <div>
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50 mb-4">Defaults</h3>
                  <div className="p-4 bg-gray-50 dark:bg-white/3 rounded-xl border border-gray-200 dark:border-white/8">
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-gray-900 dark:text-gray-50">Default assistant</p>
                      <span className="text-sm font-mono px-2 py-1 rounded-sm bg-white dark:bg-white/6 border border-gray-200 dark:border-white/8 text-gray-700 dark:text-gray-200">
                        {globalSettings?.default_cli || '—'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'ai-agents' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50">CLI Agents</h3>
                    {/* Inline Default CLI Selector */}
                    <div className="flex items-center gap-2 ml-6 pl-6 border-l border-gray-200 dark:border-white/8 ">
                      <span className="text-sm text-gray-600 dark:text-gray-300 ">Default:</span>
                      <select
                        value={globalSettings.default_cli}
                        onChange={(e) => setDefaultCLI(e.target.value)}
                        className="pl-3 pr-8 py-1.5 text-xs font-medium border border-gray-200 dark:border-white/8 rounded-full bg-transparent hover:bg-gray-50 dark:hover:bg-white/6 hover:border-gray-300 dark:hover:border-white/18 text-gray-700 dark:text-gray-200 focus:outline-hidden focus:ring-0 transition-colors cursor-pointer"
                      >
                        {CLI_OPTIONS.filter(cli => cliStatus[cli.id]?.installed && cli.enabled !== false).map(cli => (
                          <option key={cli.id} value={cli.id}>
                            {cli.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {saveMessage && (
                      <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm ${
                        saveMessage.type === 'success' 
                          ? 'bg-green-100 text-green-700 '
                          : 'bg-red-100 text-red-700 '
                      }`}>
                        {saveMessage.type === 'success' ? (
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        )}
                        {saveMessage.text}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={checkCLIStatus}
                        className="px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-white/8 rounded-full bg-transparent hover:bg-gray-50 dark:hover:bg-white/6 hover:border-gray-300 dark:hover:border-white/18 text-gray-700 dark:text-gray-200 transition-colors"
                      >
                        Refresh Status
                      </button>
                      <button
                        onClick={saveGlobalSettings}
                        disabled={isLoading}
                        className="px-3 py-1.5 text-xs font-medium bg-brand-500 hover:bg-brand-600 text-white rounded-full transition-colors disabled:opacity-50"
                      >
                        {isLoading ? 'Saving...' : 'Save Settings'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* CLI Agents Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {CLI_OPTIONS.filter(cli => cli.enabled !== false).map((cli) => {
                    const status = cliStatus[cli.id];
                    const settings = globalSettings.cli_settings[cli.id] || {};
                    const isChecking = status?.checking || false;
                    const isInstalled = status?.installed || false;
                    const isDefault = globalSettings.default_cli === cli.id;

                    return (
                      <div 
                        key={cli.id} 
                        onClick={() => isInstalled && setDefaultCLI(cli.id)}
                        className={`border rounded-xl pl-4 pr-8 py-4 transition-all ${
                          !isInstalled
                            ? 'border-gray-200 dark:border-white/6 cursor-not-allowed bg-gray-50 dark:bg-white/2 '
                            : isDefault
                              ? 'cursor-pointer'
                              : 'border-gray-200 dark:border-white/8 hover:border-gray-300 dark:hover:border-white/18 hover:bg-gray-50 dark:hover:bg-white/4 cursor-pointer'
                        }`}
                        style={isDefault && isInstalled ? {
                          borderColor: cli.brandColor,
                          backgroundColor: `${cli.brandColor}08`
                        } : {}}
                      >
                        <div className="flex items-start gap-3 mb-3">
                          <div className={`shrink-0 ${!isInstalled ? 'opacity-40' : ''}`}>
                            {cli.id === 'claude' && (
                              <Image src="/claude.png" alt="Claude" width={32} height={32} className="w-8 h-8" />
                            )}
                            {cli.id === 'cursor' && (
                              <Image src="/cursor.png" alt="Cursor" width={32} height={32} className="w-8 h-8" />
                            )}
                            {cli.id === 'codex' && (
                              <Image src="/oai.png" alt="Codex" width={32} height={32} className="w-8 h-8" />
                            )}
                            {cli.id === 'qwen' && (
                              <Image src="/qwen.png" alt="Qwen" width={32} height={32} className="w-8 h-8" />
                            )}
                            {cli.id === 'glm' && (
                              <Image src="/glm.svg" alt="GLM" width={32} height={32} className="w-8 h-8" />
                            )}
                            {cli.id === 'gemini' && (
                              <Image src="/gemini.png" alt="Gemini" width={32} height={32} className="w-8 h-8" />
                            )}
                          </div>
                          <div className={`flex-1 min-w-0 ${!isInstalled ? 'opacity-40' : ''}`}>
                            <div className="flex items-center gap-2">
                              <h4 className="font-medium text-gray-900 dark:text-gray-50 text-sm">{cli.name}</h4>
                              {isDefault && isInstalled && (
                                <span className="text-xs font-medium" style={{ color: cli.brandColor }}>
                                  Default
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Model Selection or Not Installed */}
                        {isInstalled ? (
                          <div onClick={(e) => e.stopPropagation()} className="space-y-3">
                            <select
                              value={settings.model || ''}
                              onChange={(e) => setDefaultModel(cli.id, e.target.value)}
                              className="w-full px-3 py-1.5 border border-gray-200 dark:border-white/8 rounded-full bg-transparent hover:bg-gray-50 dark:hover:bg-white/6 text-gray-700 dark:text-gray-200 text-xs font-medium transition-colors focus:outline-hidden focus:ring-0"
                            >
                              <option value="">Select model</option>
                              {cli.models.map(model => (
                                <option key={model.id} value={model.id}>
                                  {model.name}
                                </option>
                              ))}
                            </select>

                            {cli.id === 'glm' && (
                              <div className="space-y-1.5">
                                <label className="text-xs font-medium text-gray-600 dark:text-gray-300 ">
                                  API Key
                                </label>
                                <div className="flex items-center gap-2">
                                  <input
                                    type={apiKeyVisibility[cli.id] ? 'text' : 'password'}
                                    value={settings.apiKey ?? ''}
                                    onChange={(e) => setCliApiKey(cli.id, e.target.value)}
                                    placeholder="Enter GLM API key"
                                    className="flex-1 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-white/8 bg-white dark:bg-white/6 text-sm text-gray-700 dark:text-gray-200 focus:outline-hidden focus:ring-2 focus:ring-brand-500/50"
                                  />
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      toggleApiKeyVisibility(cli.id);
                                    }}
                                    className="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 border border-gray-200 dark:border-white/8 rounded-lg bg-white dark:bg-white/6 transition-colors"
                                  >
                                    {apiKeyVisibility[cli.id] ? 'Hide' : 'Show'}
                                  </button>
                                </div>
                              </div>
                            )}
                            {cli.id === 'cursor' && (
                              <div className="space-y-1.5">
                                <label className="text-xs font-medium text-gray-600 dark:text-gray-300 ">
                                  API Key (optional)
                                </label>
                                <div className="flex items-center gap-2">
                                  <input
                                    type={apiKeyVisibility[cli.id] ? 'text' : 'password'}
                                    value={settings.apiKey ?? ''}
                                    onChange={(e) => setCliApiKey(cli.id, e.target.value)}
                                    placeholder="Enter Cursor API key"
                                    className="flex-1 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-white/8 bg-white dark:bg-white/6 text-sm text-gray-700 dark:text-gray-200 focus:outline-hidden focus:ring-2 focus:ring-brand-500/50"
                                  />
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      toggleApiKeyVisibility(cli.id);
                                    }}
                                    className="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 border border-gray-200 dark:border-white/8 rounded-lg bg-white dark:bg-white/6 transition-colors"
                                  >
                                    {apiKeyVisibility[cli.id] ? 'Hide' : 'Show'}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => {
                                setSelectedCLI(cli);
                                setInstallModalOpen(true);
                              }}
                              className="w-full px-3 py-1.5 rounded-full bg-brand-500 hover:bg-brand-600 text-white text-xs font-semibold transition-all transform hover:scale-105"
                            >
                              View Guide
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  
                </div>
              </div>
            )}

            {activeTab === 'claude' && currentUser && (
              <ClaudeAccountSettings onToast={showToast} />
            )}

            {activeTab === 'account' && currentUser && (
              <MyAccountSettings user={currentUser} onToast={showToast} onChanged={loadCurrentUser} />
            )}

            {activeTab === 'shared-mcp' && canManageOrg && <SharedMcpSettings />}
            {activeTab === 'plugins' && canManageOrg && <PluginSettings />}
            {activeTab === 'system' && isAdmin && <SystemOverviewSettings />}
            {activeTab === 'users' && isAdmin && currentUser && (
              <UsersSettings currentUserId={currentUser.id} onToast={showToast} />
            )}

            {activeTab === 'about' && (
              <div className="space-y-6">
                <div className="text-center">
                  <div className="w-20 h-20 mx-auto mb-4 relative">
                    <div className="absolute inset-0 bg-linear-to-br from-brand-500/20 to-brand-500/5 blur-xl rounded-2xl" />
                    <Image
                      src="/Claudable_Icon.png"
                      alt="Claudable Icon"
                      width={80}
                      height={80}
                      className="relative z-10 w-full h-full object-contain rounded-2xl shadow-lg"
                    />
                  </div>
                  <BrandWordmark className="mx-auto h-[26px] w-[150px] bg-gray-900 dark:bg-white" />
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-3">Version 1.0.0 · Self-hosted</p>
                </div>

                <div className="text-center">
                  <div className="flex justify-center gap-6">
                    <a 
                      href="https://github.com/opactorai/Claudable" 
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-brand-500 hover:text-[#c95940] transition-colors"
                    >
                      GitHub
                    </a>
                    <a 
                      href="https://discord.gg/NJNbafHNQC" 
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-brand-500 hover:text-[#c95940] transition-colors"
                    >
                      Discord
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        </MotionDiv>
      </div>
      
      {/* Toast notification */}
      {toast && (
        <div className={`fixed bottom-4 right-4 z-80 px-4 py-3 rounded-lg shadow-2xl transition-all transform animate-slide-in-up ${
          toast.type === 'success' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
        }`}>
          <div className="flex items-center gap-2">
            {toast.type === 'success' && (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
            <span className="font-medium">{toast.message}</span>
          </div>
        </div>
      )}

      {/* Install Guide Modal */}
      {installModalOpen && selectedCLI && (
        <div className="fixed inset-0 z-70 flex items-center justify-center p-4" key={`modal-${selectedCLI.id}`}>
          <div 
            className="absolute inset-0 bg-black/60 backdrop-blur-md"
            onClick={() => {
              setInstallModalOpen(false);
              setSelectedCLI(null);
            }}
          />
          
          <div 
            className="relative bg-white dark:bg-[#181310] rounded-2xl shadow-2xl w-full max-w-lg border border-gray-200 dark:border-white/10 transform"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="p-5 border-b border-gray-200 dark:border-white/8">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {selectedCLI.id === 'claude' && (
                    <Image src="/claude.png" alt="Claude" width={32} height={32} className="w-8 h-8" />
                  )}
                  {selectedCLI.id === 'cursor' && (
                    <Image src="/cursor.png" alt="Cursor" width={32} height={32} className="w-8 h-8" />
                  )}
                  {selectedCLI.id === 'codex' && (
                    <Image src="/oai.png" alt="Codex" width={32} height={32} className="w-8 h-8" />
                  )}
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-50 ">
                    Install {selectedCLI.name}
                  </h3>
                </div>
                <button
                  onClick={() => {
                    setInstallModalOpen(false);
                    setSelectedCLI(null);
                  }}
                  className="text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition-colors p-1 hover:bg-gray-100 dark:hover:bg-white/6 rounded-lg"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="p-6 space-y-4">
              {/* Step 1: Install */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-50 ">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full text-white text-xs" style={{ backgroundColor: selectedCLI.brandColor }}>
                    1
                  </span>
                  Install CLI
                </div>
                <div className="ml-8 flex items-center gap-2 bg-gray-100 dark:bg-white/6 rounded-lg px-3 py-2">
                  <code className="text-sm text-gray-800 dark:text-gray-100 flex-1">
                    {selectedCLI.installCommand}
                  </code>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      navigator.clipboard.writeText(selectedCLI.installCommand);
                      showToast('Command copied to clipboard', 'success');
                    }}
                    className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 "
                    title="Copy command"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M9 3h10a2 2 0 012 2v10M9 3H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-2M9 3v2a2 2 0 002 2h6a2 2 0 002-2V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Step 2: Authenticate */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-50 ">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full text-white text-xs" style={{ backgroundColor: selectedCLI.brandColor }}>
                    2
                  </span>
                  {selectedCLI.id === 'gemini' && 'Authenticate (OAuth or API Key)'}
                  {selectedCLI.id === 'glm' && 'Authenticate (Z.ai DevPack login)'}
                  {selectedCLI.id === 'qwen' && 'Authenticate (Qwen OAuth or API Key)'}
                  {selectedCLI.id === 'codex' && 'Start Codex and sign in'}
                  {selectedCLI.id === 'claude' && 'Start Claude and sign in'}
                  {selectedCLI.id === 'cursor' && 'Start Cursor CLI and sign in'}
                </div>
                <div className="ml-8 flex items-center gap-2 bg-gray-100 dark:bg-white/6 rounded-lg px-3 py-2">
                  <code className="text-sm text-gray-800 dark:text-gray-100 flex-1">
                    {selectedCLI.id === 'claude' ? 'claude' :
                     selectedCLI.id === 'cursor' ? 'cursor-agent' :
                     selectedCLI.id === 'codex' ? 'codex' :
                     selectedCLI.id === 'qwen' ? 'qwen' :
                     selectedCLI.id === 'glm' ? 'zai' :
                     selectedCLI.id === 'gemini' ? 'gemini' : ''}
                  </code>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const authCmd = selectedCLI.id === 'claude' ? 'claude' :
                                      selectedCLI.id === 'cursor' ? 'cursor-agent' :
                                      selectedCLI.id === 'codex' ? 'codex' :
                                      selectedCLI.id === 'qwen' ? 'qwen' :
                                      selectedCLI.id === 'glm' ? 'zai' :
                                      selectedCLI.id === 'gemini' ? 'gemini' : '';
                      if (authCmd) navigator.clipboard.writeText(authCmd);
                      showToast('Command copied to clipboard', 'success');
                    }}
                    className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 "
                    title="Copy command"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M9 3h10a2 2 0 012 2v10M9 3H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-2M9 3v2a2 2 0 002 2h6a2 2 0 002-2V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Step 3: Test */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-50 ">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full text-white text-xs" style={{ backgroundColor: selectedCLI.brandColor }}>
                    3
                  </span>
                  Test your installation
                </div>
                <div className="ml-8 flex items-center gap-2 bg-gray-100 dark:bg-white/6 rounded-lg px-3 py-2">
                  <code className="text-sm text-gray-800 dark:text-gray-100 flex-1">
                    {selectedCLI.id === 'claude' ? 'claude --version' :
                     selectedCLI.id === 'cursor' ? 'cursor-agent --version' :
                     selectedCLI.id === 'codex' ? 'codex --version' :
                     selectedCLI.id === 'qwen' ? 'qwen --version' :
                     selectedCLI.id === 'glm' ? 'zai --version' :
                     selectedCLI.id === 'gemini' ? 'gemini --version' : ''}
                  </code>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const versionCmd = selectedCLI.id === 'claude' ? 'claude --version' :
                                        selectedCLI.id === 'cursor' ? 'cursor-agent --version' :
                                        selectedCLI.id === 'codex' ? 'codex --version' :
                                        selectedCLI.id === 'qwen' ? 'qwen --version' :
                                        selectedCLI.id === 'glm' ? 'zai --version' :
                                        selectedCLI.id === 'gemini' ? 'gemini --version' : '';
                      if (versionCmd) navigator.clipboard.writeText(versionCmd);
                      showToast('Command copied to clipboard', 'success');
                    }}
                    className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 "
                    title="Copy command"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M9 3h10a2 2 0 012 2v10M9 3H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-2M9 3v2a2 2 0 002 2h6a2 2 0 002-2V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Minimal guide only; removed extra info */}
            </div>

            {/* Footer */}
            <div className="p-5 border-t border-gray-200 dark:border-white/8 flex justify-between">
              <button
                onClick={() => checkCLIStatus()}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
              >
                Refresh Status
              </button>
              <button
                onClick={() => {
                  setInstallModalOpen(false);
                  setSelectedCLI(null);
                }}
                className="px-4 py-2 text-sm bg-brand-500 hover:bg-brand-600 text-white rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </AnimatePresence>
  );
}
