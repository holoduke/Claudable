import type { Project as ProjectEntity } from '@/types/backend';
import type { Project } from '@/types';

type UserRef = { name?: string | null; email?: string | null } | null | undefined;
function userLabel(u: UserRef): string | null {
  if (!u) return null;
  return u.name?.trim() || u.email?.trim() || null;
}

export function serializeProject(project: ProjectEntity): Project {
  // owner / lastEditedBy are present when the query includes those relations
  // (getAllProjects for the homepage tiles); absent elsewhere → null.
  const withRel = project as ProjectEntity & { owner?: UserRef; lastEditedBy?: UserRef };
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? null,
    status: project.status,
    previewUrl: project.previewUrl ?? null,
    previewPort: project.previewPort ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    lastActiveAt: project.lastActiveAt ? project.lastActiveAt.toISOString() : null,
    initialPrompt: project.initialPrompt ?? null,
    preferredCli: (project.preferredCli ?? null) as Project['preferredCli'],
    selectedModel: project.selectedModel ?? null,
    fallbackEnabled: project.fallbackEnabled,
    createdBy: userLabel(withRel.owner),
    lastEditedBy: userLabel(withRel.lastEditedBy),
  };
}

export function serializeProjects(projects: ProjectEntity[]): Project[] {
  return projects.map((project) => serializeProject(project));
}
