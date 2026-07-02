/**
 * A project's runtime "containers": frontend, optional backend, optional
 * database — the composition. GET lists them with type/status/URL/description;
 * POST adds a backend or database; DELETE removes one.
 *   GET  -> { containers: [...] }
 *   POST { backendId } | { databaseId }
 *   DELETE ?kind=backend|database
 */
import { NextRequest } from 'next/server';
import path from 'path';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { canAccessProject } from '@/lib/services/project-access';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';
import { stackKind } from '@/lib/config/stacks';
import { getBackendStack, isValidBackend } from '@/lib/config/backend-stacks';
import { getDatabaseOption, isValidDatabase } from '@/lib/config/databases';
import { getDatabaseInfo, provisionPostgres, removeDatabase } from '@/lib/services/database';

export const runtime = 'nodejs';

interface RouteContext { params: Promise<{ project_id: string }>; }

// preview-<slug>.host -> preview-<slug>-api.host
function apiUrlFrom(previewUrl: string | null): string | null {
  if (!previewUrl) return null;
  return previewUrl.replace(/^(https?:\/\/[^.]+)/u, '$1-api');
}
function safeSettings(raw: string | null): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
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
    const { project, error } = await gate(project_id);
    if (error) return error;

    const settings = safeSettings(project!.settings);
    const running = project!.status === 'running' || !!project!.previewUrl;
    const feKind = project!.templateType || stackKind(project!.templateType);
    const containers: Array<Record<string, unknown>> = [];

    containers.push({
      kind: 'frontend',
      name: 'Frontend',
      type: `${feKind} · container`,
      status: running ? 'running' : 'stopped',
      url: project!.previewUrl,
      description: 'The app UI — runs as an isolated, egress-locked container.',
      removable: false,
    });

    const backendType = typeof settings.backendType === 'string' ? settings.backendType : null;
    if (backendType) {
      const b = getBackendStack(backendType);
      containers.push({
        kind: 'backend',
        name: 'Backend',
        type: `${b?.name ?? backendType} · container`,
        status: running ? 'running' : 'stopped',
        url: apiUrlFrom(project!.previewUrl),
        description: `${b?.description ?? 'API service'} Runs in its own isolated container; reachable under /api.`,
        removable: true,
      });
    }

    const databaseType = typeof settings.databaseType === 'string' ? settings.databaseType : null;
    if (databaseType) {
      const d = getDatabaseOption(databaseType);
      let status = databaseType === 'sqlite' ? 'file' : 'not provisioned';
      let host: string | null = null;
      if (d?.managed) {
        try {
          const info = await getDatabaseInfo(project_id);
          if (info.provisioned) { status = 'provisioned'; host = (info as { host?: string }).host ?? null; }
        } catch { /* Coolify may be unconfigured */ }
      }
      containers.push({
        kind: 'database',
        name: 'Database',
        type: d?.managed ? `${d?.name} · managed` : `${d?.name ?? databaseType} · file`,
        status,
        url: host,
        description: d?.description ?? 'Application data.',
        removable: true,
      });
    }

    return createSuccessResponse({ containers });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to load containers');
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const { project, error } = await gate(project_id);
    if (error) return error;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const backendId = typeof body.backendId === 'string' ? body.backendId : '';
    const databaseId = typeof body.databaseId === 'string' ? body.databaseId : '';
    if (!isValidBackend(backendId) && !isValidDatabase(databaseId)) {
      return createErrorResponse('bad_request', 'Provide a valid backendId or databaseId', 400);
    }
    const settings = safeSettings(project!.settings);
    if (isValidBackend(backendId)) {
      settings.backendType = backendId;
      if (project!.repoPath) {
        const { scaffoldBackend } = await import('@/lib/utils/scaffold-backend');
        await scaffoldBackend(path.resolve(project!.repoPath), backendId);
      }
    }
    if (isValidDatabase(databaseId)) {
      settings.databaseType = databaseId;
      // Managed Postgres is actually provisioned via Coolify (best-effort — the
      // type is still recorded so the preview can inject it once available).
      if (databaseId === 'postgres') {
        try { await provisionPostgres(project_id); } catch (e) { console.error('[containers] provisionPostgres failed:', e); }
      }
    }
    await prisma.project.update({ where: { id: project_id }, data: { settings: JSON.stringify(settings) } });
    return createSuccessResponse({ ok: true });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to add container');
  }
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const { project, error } = await gate(project_id);
    if (error) return error;
    const kind = new URL(req.url).searchParams.get('kind');
    const settings = safeSettings(project!.settings);
    if (kind === 'backend') delete settings.backendType;
    else if (kind === 'database') {
      if (settings.databaseType === 'postgres') { try { await removeDatabase(project_id); } catch (e) { console.error('[containers] removeDatabase failed:', e); } }
      delete settings.databaseType;
    }
    else return createErrorResponse('bad_request', 'kind must be backend or database', 400);
    await prisma.project.update({ where: { id: project_id }, data: { settings: JSON.stringify(settings) } });
    return createSuccessResponse({ ok: true });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to remove container');
  }
}
