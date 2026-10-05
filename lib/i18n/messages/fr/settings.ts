import type { settingsEn } from '../en/settings';
import { settingsProjectFr } from './settings-project';
import { settingsDeployFr } from './settings-deploy';
import { settingsAdminFr } from './settings-admin';
import { settingsToolsFr } from './settings-tools';

/** FR strings for the settings area — same keys as en/settings.ts. */
export const settingsFr: Record<keyof typeof settingsEn, string> = {
  ...settingsProjectFr,
  ...settingsDeployFr,
  ...settingsAdminFr,
  ...settingsToolsFr,
};
