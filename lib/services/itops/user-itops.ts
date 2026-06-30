/**
 * Resolve whether the it-ops broker should attach for a given project.
 *
 * it-ops is a per-USER capability (not per-project): it's on for every project
 * owned by a user who has `itopsEnabled`. Admins self-enable; admins can also
 * enable it for other users (see the users API + UI).
 */
import { prisma } from '@/lib/db/client';

export async function isItopsEnabledForProject(projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { owner: { select: { itopsEnabled: true, isActive: true } } },
  });
  return !!(project?.owner?.isActive && project.owner.itopsEnabled);
}
