import { settingsProjectEn } from './settings-project';
import { settingsDeployEn } from './settings-deploy';
import { settingsAdminEn } from './settings-admin';
import { settingsToolsEn } from './settings-tools';

/** English strings for the settings area (merged into ../en.ts). Keys: '<area>.<name>'.
 *  Split per sub-area (project / deploy / admin) to keep files small. */
export const settingsEn = {
  ...settingsProjectEn,
  ...settingsDeployEn,
  ...settingsAdminEn,
  ...settingsToolsEn,
} as const;
