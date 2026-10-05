/**
 * What the signed-in user may do in a project — the same rules the API gates
 * enforce (lib/auth/gate.ts denyUnlessProjectAccess), computed up front so the
 * UI can hide or explain controls instead of letting them fail with a 403.
 *
 * - canWrite:     run the agent, edit files, deploy           (gate `write`)
 * - canManage:    secrets/env, containers, delete, general    (gate `manage`)
 * - canConfigure: project settings (skills, MCP, plugins, …)  (gate `configure`)
 * - fullEdit:     not limited by a restricted edit profile    (gate `fullEdit`)
 *
 * In a customer project `manage` and `configure` are New Story staff only.
 * With the auth gate off every gate is a no-op, so everything is true.
 */
import type { User } from '@prisma/client';
import { canManageProject, canWriteProject } from '@/lib/services/project-access';
import { isCustomerProject, isInternalUser } from '@/lib/services/tenant-policy';
import { isRestricted, resolveEditProfile } from '@/lib/services/edit-profiles';

export interface ProjectPermissions {
  canWrite: boolean;
  canManage: boolean;
  canConfigure: boolean;
  fullEdit: boolean;
}

export const ALL_PERMISSIONS: ProjectPermissions = Object.freeze({
  canWrite: true,
  canManage: true,
  canConfigure: true,
  fullEdit: true,
});

type PermissionProject = { id: string; ownerId: string | null; orgId: string | null; visibility: string };

export async function computeProjectPermissions(
  user: User,
  project: PermissionProject,
): Promise<ProjectPermissions> {
  const canWrite = await canWriteProject(user, project);
  const staffOnly = (await isCustomerProject(project.id)) && !(await isInternalUser(user));
  const { profile } = await resolveEditProfile(project.id, user.id);
  return {
    canWrite,
    canManage: canManageProject(user, project) && !staffOnly,
    canConfigure: canWrite && !staffOnly,
    fullEdit: !isRestricted(profile),
  };
}
