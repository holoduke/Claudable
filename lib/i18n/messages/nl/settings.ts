import type { settingsEn } from '../en/settings';
import { settingsProjectNl } from './settings-project';
import { settingsDeployNl } from './settings-deploy';
import { settingsAdminNl } from './settings-admin';
import { settingsToolsNl } from './settings-tools';

/** NL strings for the settings area — same keys as en/settings.ts. */
export const settingsNl: Record<keyof typeof settingsEn, string> = {
  ...settingsProjectNl,
  ...settingsDeployNl,
  ...settingsAdminNl,
  ...settingsToolsNl,
};
