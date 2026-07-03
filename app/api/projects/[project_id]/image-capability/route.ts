/**
 * Per-project image-generation capability connection.
 *   GET    -> { connected, hasOwnKey, usesGlobalKey, globalAvailable }
 *   POST { apiKey? }  -> connect (opt-in); optional own key, else the shared key
 *   DELETE            -> disconnect
 */
import { NextRequest } from 'next/server';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canAccessProject } from '@/lib/services/project-access';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';
import { getImagesConnection, connectImages, disconnectImages } from '@/lib/services/capabilities/images';

export const runtime = 'nodejs';

interface RouteContext { params: Promise<{ project_id: string }>; }

async function gate(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return { error: createErrorResponse('not_found', 'Project not found', 404) };
  if (authEnabled()) {
    const user = await getSessionUser();
    if (!user) return { error: createErrorResponse('unauthorized', 'Authentication required', 401) };
    if (!(await canAccessProject(user, project))) return { error: createErrorResponse('forbidden', 'Access denied', 403) };
  }
  return { project };
}

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const { error } = await gate(project_id);
    if (error) return error;
    return createSuccessResponse(await getImagesConnection(project_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to load image capability');
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const { error } = await gate(project_id);
    if (error) return error;
    const body = (await req.json().catch(() => ({}))) as { apiKey?: unknown };
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : undefined;
    await connectImages(project_id, apiKey);
    return createSuccessResponse(await getImagesConnection(project_id));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to connect image capability');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const { error } = await gate(project_id);
    if (error) return error;
    await disconnectImages(project_id);
    return createSuccessResponse({ connected: false });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to disconnect image capability');
  }
}
