/**
 * A project's runtime "containers": frontend, optional backend, optional
 * database — the composition. GET lists them with type/status/URL/description;
 * POST adds a backend or database; DELETE removes one.
 *   GET  -> { containers: [...] }
 *   POST { backendId } | { databaseId }
 *   DELETE ?kind=backend|database
 */
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
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

    // A backend can come from the composition (settings.backendType) OR from an
    // imported project's .claudable/preview.json (e.g. Farmer Gracy, set up at
    // import before the composition feature). Detect either.
    const backendType = typeof settings.backendType === 'string' ? settings.backendType : null;
    let importedBackend = false;
    let importedBackendEnv: Record<string, unknown> = {};
    let importedLang = '';
    if (!backendType && project!.repoPath) {
      const root = path.resolve(project!.repoPath);
      try {
        const cfg = JSON.parse(await fs.readFile(path.join(root, '.claudable', 'preview.json'), 'utf8'));
        importedBackend = !!cfg?.backend?.container;
        importedBackendEnv = cfg?.backend?.container?.env ?? {};
      } catch { /* none */ }
      if (importedBackend) {
        // Detect the language from the backend dir for a nicer label.
        const has = async (f: string) => fs.access(path.join(root, 'backend', f)).then(() => true).catch(() => false);
        if (await has('go.mod')) importedLang = 'Go';
        else if (await has('package.json')) importedLang = 'Node.js';
        else if (await has('requirements.txt')) importedLang = 'Python';
      }
    }
    if (backendType || importedBackend) {
      const b = getBackendStack(backendType);
      const isStaticProj = project!.templateType === 'static';
      const label = b?.name ?? importedLang ?? '';
      containers.push({
        kind: 'backend',
        name: 'Backend',
        type: label ? `${label} · container` : 'container',
        status: running ? 'running' : 'stopped',
        // Composed (framework) backends get their own -api URL; an imported
        // static-site backend is proxied at /api on the frontend's URL.
        url: isStaticProj ? (project!.previewUrl ? `${project!.previewUrl}/api` : null) : apiUrlFrom(project!.previewUrl),
        description: `${b?.description ?? 'API service.'} Runs in its own isolated container; reachable under /api.`,
        removable: !!backendType,
      });
      // An imported backend that keeps its data in a file (DATA_DIR) has an
      // embedded SQLite-style store — surface it, but be clear it lives IN the
      // backend rather than as a separate managed service.
      if (importedBackend && !settings.databaseType && typeof importedBackendEnv.DATA_DIR === 'string') {
        containers.push({
          kind: 'database',
          name: 'Database',
          type: 'file · in backend',
          status: 'embedded',
          url: null,
          description: `Embedded data store inside the backend (${importedBackendEnv.DATA_DIR}). Not a separate service.`,
          removable: false,
        });
      }
    }

    // MANAGED CONTAINERS (generic): every per-project container the project runs
    // — its database, a cache, a custom image, anything. Listed by id so any
    // number/kind shows up without hardcoding.
    const { listServiceViews, serviceStatuses } = await import('@/lib/services/managed-containers');
    type SvcStatuses = Awaited<ReturnType<typeof serviceStatuses>>;
    const managed = await listServiceViews(project_id).catch(() => []);
    const statuses: SvcStatuses = managed.length ? await serviceStatuses(project_id).catch(() => ({} as SvcStatuses)) : {};
    for (const s of managed) {
      const addr = `${s.alias}${s.ports[0] ? `:${s.ports[0]}` : ''} (internal)`;
      const rt = statuses[s.id];
      containers.push({
        kind: s.kind === 'database' ? 'database' : 'service',
        id: s.id,
        name: s.name,
        type: `${s.image}${s.injectKeys.length ? ` · ${s.injectKeys.join(', ')}` : ''}`,
        // Live docker state: running / exited / not started (falls back to 'container').
        status: rt ? (rt.running ? 'running' : (rt.state || 'stopped')) : 'container',
        statusDetail: rt?.status,
        url: addr,
        description: `${s.hasVolume ? 'Persistent container' : 'Container'} on this project’s private network — reachable only by this project (alias ${s.alias}).`,
        removable: true,
        manageable: true,
        icon: s.icon || undefined,
      });
    }

    // Legacy non-container database (Coolify host DB, or a SQLite file) — only
    // when it's NOT already represented as a managed container above.
    const databaseType = typeof settings.databaseType === 'string' ? settings.databaseType : null;
    const hasManagedDb = managed.some((s) => s.kind === 'database');
    if (databaseType && !hasManagedDb) {
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
    const templateId = typeof body.templateId === 'string' ? body.templateId : '';
    const custom = (body.custom && typeof body.custom === 'object') ? body.custom as Record<string, unknown> : null;

    // Generic: add a container from a TEMPLATE (redis/mongo/mysql/…) or a fully
    // CUSTOM image — no hardcoded kinds. (backendId/databaseId kept for the
    // built-in composition slots.)
    if (templateId || custom) {
      const { managedContainersEnabled, addServiceFromTemplate, addCustomService } = await import('@/lib/services/managed-containers');
      if (!managedContainersEnabled()) {
        return createErrorResponse('unavailable', 'Managed containers need container isolation (PREVIEW_ISOLATION) enabled on this server.', 400);
      }
      if (templateId) {
        const { getContainerTemplate } = await import('@/lib/config/container-templates');
        if (!getContainerTemplate(templateId)) return createErrorResponse('bad_request', `Unknown template: ${templateId}`, 400);
        const spec = await addServiceFromTemplate(project_id, templateId);
        return createSuccessResponse({ ok: true, id: spec.id });
      }
      const image = typeof custom!.image === 'string' ? custom!.image.trim() : '';
      if (!image) return createErrorResponse('bad_request', 'A custom container needs an image.', 400);
      const parseEnv = (v: unknown): Record<string, string> | undefined =>
        (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, String(val)])) : undefined;
      const spec = await addCustomService(project_id, {
        name: typeof custom!.name === 'string' && custom!.name.trim() ? custom!.name.trim() : image,
        image,
        alias: typeof custom!.alias === 'string' ? custom!.alias : undefined,
        kind: typeof custom!.kind === 'string' ? custom!.kind : undefined,
        env: parseEnv(custom!.env),
        injectEnv: parseEnv(custom!.injectEnv),
        mountPath: typeof custom!.mountPath === 'string' ? custom!.mountPath : undefined,
        ports: Array.isArray(custom!.ports) ? (custom!.ports as unknown[]).map(Number).filter((n) => Number.isInteger(n)) : undefined,
        dependsOn: Array.isArray(custom!.dependsOn) ? (custom!.dependsOn as unknown[]).map(String) : undefined,
      });
      return createSuccessResponse({ ok: true, id: spec.id });
    }

    if (!isValidBackend(backendId) && !isValidDatabase(databaseId)) {
      return createErrorResponse('bad_request', 'Provide a valid backendId, databaseId, templateId, or custom container', 400);
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
      // Postgres: prefer a PER-PROJECT CONTAINER database (own container on the
      // project's internal net, reachable only by this project). Falls back to the
      // legacy Coolify host DB only when container isolation isn't available.
      if (databaseId === 'postgres') {
        const { managedContainersEnabled, ensurePostgresService } = await import('@/lib/services/managed-containers');
        if (managedContainersEnabled()) {
          try { await ensurePostgresService(project_id); } catch (e) { console.error('[containers] ensurePostgresService failed:', e); }
        } else {
          try { await provisionPostgres(project_id); } catch (e) { console.error('[containers] provisionPostgres failed:', e); }
        }
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
    const url = new URL(req.url);
    const serviceId = url.searchParams.get('serviceId');
    const kind = url.searchParams.get('kind');

    // Generic: remove any managed container by its id (drops its volume).
    if (serviceId) {
      const { removeService, getServices } = await import('@/lib/services/managed-containers');
      const spec = (await getServices(project_id)).find((s) => s.id === serviceId);
      await removeService(project_id, serviceId, { deleteVolume: true });
      // If it was the DB backing the composition slot, clear that too.
      if (spec?.kind === 'database') {
        const settings = safeSettings(project!.settings);
        delete settings.databaseType;
        await prisma.project.update({ where: { id: project_id }, data: { settings: JSON.stringify(settings) } });
      }
      return createSuccessResponse({ ok: true });
    }

    const settings = safeSettings(project!.settings);
    if (kind === 'backend') delete settings.backendType;
    else if (kind === 'database') {
      if (settings.databaseType === 'postgres') {
        // Remove the per-project container DB (and its volume) if present;
        // otherwise tear down the legacy Coolify DB. Find the DB service by KIND,
        // not a hardcoded id — the spec's id is the template id ('postgres'/'mysql'),
        // not necessarily 'db'.
        const { getServices, removeService } = await import('@/lib/services/managed-containers');
        const dbSvc = (await getServices(project_id)).find((s) => s.kind === 'database');
        if (dbSvc) {
          try { await removeService(project_id, dbSvc.id, { deleteVolume: true }); } catch (e) { console.error('[containers] removeService(db) failed:', e); }
        } else {
          try { await removeDatabase(project_id); } catch (e) { console.error('[containers] removeDatabase failed:', e); }
        }
      }
      delete settings.databaseType;
    }
    else return createErrorResponse('bad_request', 'Provide serviceId, or kind=backend|database', 400);
    await prisma.project.update({ where: { id: project_id }, data: { settings: JSON.stringify(settings) } });
    return createSuccessResponse({ ok: true });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to remove container');
  }
}
