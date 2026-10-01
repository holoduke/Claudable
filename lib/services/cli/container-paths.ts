/**
 * The containerized agent sees the project at /work, while Claudable knows it by
 * its own path (/app/data/projects/<id>). Messages that name project files (chat
 * attachments: "Image #1 path: /app/data/projects/<id>/assets/x.png") are
 * rewritten so the agent can open them directly.
 */
export const AGENT_PROJECT_ROOT = '/work';

/** Rewrite references to the project's host path into the agent container's /work. */
export function toAgentContainerPaths(text: string, projectAbsPath: string): string {
  const root = projectAbsPath.replace(/\/+$/u, '');
  if (!root) return text;
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // Only where the root path really ends (`/`, end, or a non-name character), so
  // ".../p1" never rewrites ".../p10".
  return text.replace(new RegExp(`${escaped}(?=/|$|[^\\w.-])`, 'gu'), AGENT_PROJECT_ROOT);
}

