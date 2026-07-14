/**
 * English message catalog — the SOURCE OF TRUTH for i18n keys. Every other
 * locale mirrors these keys; missing keys fall back to English (see t()).
 * Flat dot-notation keys keep lookups + translation simple. `{name}`-style
 * placeholders are interpolated by t(key, { name }).
 */
export const en = {
  // Common actions / states
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.delete': 'Delete',
  'common.remove': 'Remove',
  'common.edit': 'Edit',
  'common.confirm': 'Confirm',
  'common.back': 'Back',
  'common.next': 'Next',
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.search': 'Search',
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',
  'common.on': 'On',
  'common.off': 'Off',
  'common.yes': 'Yes',
  'common.no': 'No',

  // Top bar / preview
  'topbar.publish': 'Publish',
  'topbar.publishing': 'Publishing…',
  'topbar.publishTitle': 'Publish this project',
  'topbar.settings': 'Settings',
  'topbar.home': 'Home',
  'topbar.addDescription': 'Add a description…',

  // Chat input
  'chat.placeholder': 'Ask Claudable…',
  'chat.act': 'Act',
  'chat.chat': 'Chat',
  'chat.send': 'Send',
  'chat.stop': 'Stop',
  'chat.assistant': 'Assistant',
  'chat.model': 'Model',
  'chat.thinking': 'Thinking',
  'chat.revert': 'Revert to here',
  'chat.reverting': 'Reverting…',
  'chat.agentWorking': 'Agent is working',
  'chat.emptyTitle': 'Start a conversation with your agent',

  // Settings shell
  'settings.title': 'Settings',
  'settings.tab.general': 'General',
  'settings.tab.aiAgents': 'AI Agents',
  'settings.tab.claude': 'Claude',
  'settings.tab.account': 'Account',
  'settings.tab.users': 'Users',
  'settings.tab.sharedMcp': 'Shared MCP',
  'settings.tab.plugins': 'Plugins',
  'settings.tab.system': 'System',
  'settings.tab.about': 'About',

  // Settings → General
  'settings.general.title': 'General',
  'settings.general.appearance': 'Appearance',
  'settings.general.theme': 'Theme',
  'settings.general.theme.system': 'System',
  'settings.general.theme.light': 'Light',
  'settings.general.theme.dark': 'Dark',
  'settings.general.language': 'Language',
  'settings.general.languageDesc': 'Choose the display language for the interface.',
};

export type MessageKey = keyof typeof en;
