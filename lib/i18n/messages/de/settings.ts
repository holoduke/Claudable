import type { settingsEn } from '../en/settings';
import { settingsProjectDe } from './settings-project';
import { settingsDeployDe } from './settings-deploy';
import { settingsAdminDe } from './settings-admin';
import { settingsToolsDe } from './settings-tools';

/** DE strings for the settings area — same keys as en/settings.ts. */
export const settingsDe: Record<keyof typeof settingsEn, string> = {
  ...settingsProjectDe,
  ...settingsDeployDe,
  ...settingsAdminDe,
  ...settingsToolsDe,
};
