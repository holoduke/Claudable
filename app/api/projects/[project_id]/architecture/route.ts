/**
 * Return the project's architecture summary — the `.claudable/ARCHITECTURE.md`
 * that the preview regenerates on each start (stack, isolation, ports, deploy).
 * Falls back to a minimal summary if the preview hasn't run yet.
 *   GET -> { content: markdown }
 */
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canAccessProject } from '@/lib/services/project-access';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const project = await prisma.project.findUnique({ where: { id: project_id } });
    if (!project) return createErrorResponse('not_found', 'Project not found', 404);
    if (authEnabled()) {
      const user = await getSessionUser();
      if (!user) return createErrorResponse('unauthorized', 'Authentication required', 401);
      if (!(await canAccessProject(user, project))) return createErrorResponse('forbidden', 'Access denied', 403);
    }

    const projectPath = project.repoPath
      ? path.resolve(project.repoPath)
      : path.join(process.cwd(), 'projects', project_id);

    let content: string | null = null;
    try {
      content = await fs.readFile(path.join(projectPath, '.claudable', 'ARCHITECTURE.md'), 'utf8');
    } catch {
      /* not generated yet — the preview writes it on start */
    }

    if (!content) {
      content =
        `# ${project.name} — Architecture\n\n` +
        `> Start the preview to generate the full runtime architecture summary.\n\n` +
        `- **Stack:** ${project.templateType || 'unknown'}\n`;
    }

    return createSuccessResponse({ content });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to load architecture');
  }
}
