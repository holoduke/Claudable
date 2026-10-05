/**
 * Project Settings Component
 * Main settings modal with tabs. Tabs are permission-aware: a tab the signed-in
 * user cannot use is shown locked with a one-line explanation instead of
 * rendering controls that would fail with a 403 (see settings-permissions).
 */
import React, { useId, useMemo, useState } from 'react';
import { FaCog, FaRobot, FaLock, FaPlug, FaUsers, FaPalette, FaCube, FaMagic } from 'react-icons/fa';
import { useT } from '@/contexts/I18nContext';
import type { MessageKey } from '@/lib/i18n/messages/en';
import { SettingsModal } from './SettingsModal';
import { GeneralSettings } from './GeneralSettings';
import { AIAssistantSettings } from './AIAssistantSettings';
import { EnvironmentSettings } from './EnvironmentSettings';
import { ServiceSettings } from './ServiceSettings';
import { SkillsSettings } from './SkillsSettings';
import ProjectAccessSettings from './ProjectAccessSettings';
import ProjectOrganisationSettings from './ProjectOrganisationSettings';
import DesignSettings from './DesignSettings';
import ProjectClaudeSettings from './ProjectClaudeSettings';
import ContainersSettings from './ContainersSettings';
import McpServersSettings from './McpServersSettings';
import { ProjectPluginSettings } from './ProjectPluginSettings';
import { SETTINGS_TAB_STRIP } from './settings-a11y';
import {
  PermissionNotice,
  denyReason,
  useProjectPermissions,
  type DenyReason,
  type PermissionNeed,
} from './settings-permissions';

interface ProjectSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  projectDescription?: string | null;
  initialTab?: SettingsTab;
  onProjectUpdated?: (update: { name: string; description?: string | null }) => void;
}

type SettingsTab = 'general' | 'ai-assistant' | 'environment' | 'services' | 'containers' | 'skills' | 'mcp' | 'plugins' | 'design' | 'claude' | 'access';

interface TabDef {
  id: SettingsTab;
  label: MessageKey;
  icon: React.ReactNode;
  /** Project-only tabs are hidden in the global ("global-settings") scope. */
  projectOnly: boolean;
  /** Needed to use the tab at all (a tab with partial access handles that itself). */
  need?: PermissionNeed;
}

const icon = (node: React.ReactNode) => <span className="w-4 h-4 inline-flex" aria-hidden>{node}</span>;

// `need` mirrors the API gates the tab's controls hit (lib/auth/gate.ts):
// env routes require manage (even to read); skills/MCP/plugins/design writes
// require configure + the full edit profile; the Claude credential requires
// configure; access/members require manage. General, Containers and Deploy are
// readable by everyone and hide their manage-only controls themselves.
const TAB_DEFS: TabDef[] = [
  { id: 'general', label: 'settings.project.tab.general', icon: icon(<FaCog />), projectOnly: true },
  { id: 'ai-assistant', label: 'settings.project.tab.agent', icon: icon(<FaRobot />), projectOnly: false },
  { id: 'environment', label: 'settings.project.tab.envs', icon: icon(<FaLock />), projectOnly: true, need: 'manage' },
  { id: 'containers', label: 'settings.project.tab.containers', icon: icon(<FaCube />), projectOnly: true },
  { id: 'services', label: 'settings.project.tab.deploy', icon: icon(<FaPlug />), projectOnly: true },
  { id: 'skills', label: 'settings.project.tab.skills', icon: icon(<FaMagic />), projectOnly: true, need: 'configureFull' },
  { id: 'mcp', label: 'settings.project.tab.mcp', icon: icon(<FaPlug />), projectOnly: true, need: 'configureFull' },
  { id: 'plugins', label: 'settings.project.tab.plugins', icon: icon(<FaMagic />), projectOnly: true, need: 'configureFull' },
  { id: 'design', label: 'settings.project.tab.design', icon: icon(<FaPalette />), projectOnly: true, need: 'configureFull' },
  { id: 'claude', label: 'settings.project.tab.claude', icon: icon(<FaRobot />), projectOnly: true, need: 'configure' },
  { id: 'access', label: 'settings.project.tab.access', icon: icon(<FaUsers />), projectOnly: true, need: 'manage' },
];

export function ProjectSettings({
  isOpen,
  onClose,
  projectId,
  projectName,
  projectDescription = '',
  initialTab = 'general',
  onProjectUpdated,
}: ProjectSettingsProps) {
  const t = useT();
  const baseId = useId();
  const isProjectScoped = Boolean(projectId && projectId !== 'global-settings');
  const { permissions, loaded } = useProjectPermissions(projectId, isOpen && isProjectScoped);
  // Global scope has no project to check against; the old behaviour stands there.
  const permissionsReady = !isProjectScoped || loaded;

  const tabs = useMemo(
    () => TAB_DEFS.filter((tab) => isProjectScoped || !tab.projectOnly),
    [isProjectScoped],
  );

  const lockedReason = (tab: TabDef): DenyReason | null =>
    isProjectScoped && tab.need ? denyReason(permissions, tab.need) : null;
  const manageDenyReason = denyReason(permissions, 'manage');
  const canManage = manageDenyReason === null;

  const resolvedInitialTab = useMemo<SettingsTab>(() => {
    if (initialTab && tabs.some((tab) => tab.id === initialTab)) return initialTab;
    return tabs[0]?.id ?? 'ai-assistant';
  }, [initialTab, tabs]);

  const [activeTab, setActiveTab] = useState<SettingsTab>(resolvedInitialTab);

  // Re-sync the tab when the resolved initial tab changes (adjusted during
  // render rather than in an effect).
  const [prevResolvedInitialTab, setPrevResolvedInitialTab] = useState(resolvedInitialTab);
  if (resolvedInitialTab !== prevResolvedInitialTab) {
    setPrevResolvedInitialTab(resolvedInitialTab);
    setActiveTab(resolvedInitialTab);
  }

  const activeDef = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  const activeLocked = activeDef ? lockedReason(activeDef) : null;
  const tabId = (id: SettingsTab) => `${baseId}-tab-${id}`;
  const panelId = `${baseId}-panel`;

  const renderPanel = () => {
    if (!permissionsReady) {
      return <p className="p-6 text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>;
    }
    if (activeLocked) {
      return (
        <div className="p-6">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-50 mb-4">{t(activeDef.label)}</h3>
          <PermissionNotice reason={activeLocked} />
        </div>
      );
    }
    switch (activeTab) {
      case 'general':
        return isProjectScoped ? (
          <GeneralSettings
            projectId={projectId}
            projectName={projectName}
            projectDescription={projectDescription ?? ''}
            onProjectUpdated={onProjectUpdated}
            canManage={canManage}
            manageDenyReason={manageDenyReason ?? undefined}
          />
        ) : null;
      case 'ai-assistant':
        return <AIAssistantSettings projectId={projectId} />;
      case 'environment':
        return <EnvironmentSettings projectId={projectId} />;
      case 'containers':
        return <ContainersSettings projectId={projectId} canManage={canManage} canConfigure={denyReason(permissions, 'configureFull') === null} manageDenyReason={manageDenyReason ?? undefined} />;
      case 'services':
        return <ServiceSettings projectId={projectId} projectName={projectName} canManage={canManage} manageDenyReason={manageDenyReason ?? undefined} />;
      case 'skills':
        return <SkillsSettings projectId={projectId} />;
      case 'mcp':
        return isProjectScoped ? <McpServersSettings projectId={projectId} /> : null;
      case 'plugins':
        return isProjectScoped ? <ProjectPluginSettings projectId={projectId} /> : null;
      case 'design':
        return isProjectScoped ? <DesignSettings projectId={projectId} /> : null;
      case 'claude':
        return isProjectScoped ? <ProjectClaudeSettings projectId={projectId} /> : null;
      case 'access':
        return isProjectScoped ? (
          <>
            {/* The org block carries its own outer margin (it renders nothing for non-superadmins). */}
            <ProjectOrganisationSettings projectId={projectId} />
            <ProjectAccessSettings projectId={projectId} />
          </>
        ) : null;
      default:
        return null;
    }
  };

  return (
    <SettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('settings.project.title')}
      icon={<svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>}
    >
      <div className="flex flex-col md:flex-row h-full min-h-0">
        {/* Tabs: horizontal strip on phones, sidebar from md up */}
        <div className="shrink-0 md:w-56 bg-white dark:bg-transparent border-b md:border-b-0 md:border-r border-gray-200 dark:border-white/8">
          <nav role="tablist" aria-label={t('settings.project.title')} className={SETTINGS_TAB_STRIP}>
            {tabs.map((tab) => {
              const selected = activeDef?.id === tab.id;
              const locked = permissionsReady && lockedReason(tab) !== null;
              return (
                <button
                  key={tab.id}
                  id={tabId(tab.id)}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={panelId}
                  onClick={() => setActiveTab(tab.id)}
                  className={`shrink-0 md:w-full flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 md:py-2.5 rounded-lg text-left whitespace-nowrap transition-all duration-200 border ${
                    selected
                      ? 'bg-brand-500/10 text-brand-500 border-brand-500/25 shadow-xs'
                      : 'border-transparent hover:bg-gray-50 dark:hover:bg-white/6 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
                  } ${locked && !selected ? 'opacity-60' : ''}`}
                >
                  <span className={selected ? 'text-brand-500' : 'text-gray-500 dark:text-gray-400'}>{tab.icon}</span>
                  <span className="text-sm font-medium">{t(tab.label)}</span>
                  {locked && (
                    <span className="ml-auto text-[10px] text-gray-400 dark:text-gray-500" title={t('settings.project.locked')}>
                      <FaLock aria-hidden />
                      <span className="sr-only">{t('settings.project.locked')}</span>
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Content Area */}
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={activeDef ? tabId(activeDef.id) : undefined}
          className="flex-1 min-w-0 min-h-0 overflow-y-auto bg-white dark:bg-transparent"
        >
          {renderPanel()}
        </div>
      </div>
    </SettingsModal>
  );
}

export default ProjectSettings;
