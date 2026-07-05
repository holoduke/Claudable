/**
 * Projects API Routes
 * GET /api/projects - Get all projects
 * POST /api/projects - Create new project
 */

import { NextRequest } from 'next/server';
import { getAllProjects, createProject } from '@/lib/services/project';
import type { CreateProjectInput } from '@/types/backend';
import { serializeProjects, serializeProject } from '@/lib/serializers/project';
import { getDefaultModelForCli, normalizeModelId } from '@/lib/constants/cliModels';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { accessibleProjectIds } from '@/lib/services/project-access';
import { isValidStack } from '@/lib/config/stacks';
import { isValidBackend } from '@/lib/config/backend-stacks';
import { isValidDatabase } from '@/lib/config/databases';
import { prisma } from '@/lib/db/client';
import path from 'path';

/**
 * GET /api/projects
 * Get all projects list. When the auth gate is enabled, restricted projects the
 * signed-in user isn't assigned to are filtered out (hidden entirely).
 */
export async function GET() {
  try {
    const projects = await getAllProjects();
    if (authEnabled()) {
      const me = await getSessionUser();
      // Fail CLOSED: with auth on but no resolvable session, expose nothing
      // (middleware already 401s these, this is defense-in-depth so a middleware
      // gap can't leak the whole project list — including restricted ones).
      if (!me) return createSuccessResponse(serializeProjects([]));
      // getAllProjects spreads the full Prisma row, so ownerId/orgId/visibility
      // exist at runtime even though the backend Project type omits them.
      const allowed = await accessibleProjectIds(me, projects as unknown as Parameters<typeof accessibleProjectIds>[1]);
      return createSuccessResponse(serializeProjects(projects.filter((p) => allowed.has(p.id))));
    }
    return createSuccessResponse(serializeProjects(projects));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to fetch projects');
  }
}

/**
 * POST /api/projects
 * Create new project
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) ?? {};
    const preferredCli = String(body.preferredCli || body.preferred_cli || 'claude').toLowerCase();
    const requestedModel = body.selectedModel || body.selected_model;

    const rawStack = typeof body.stackId === 'string' ? body.stackId : (typeof body.templateType === 'string' ? body.templateType : '');

    // The signed-in creator owns the project (drives per-user it-ops). Null when
    // not logged in (auth gate off) — such projects simply have no it-ops owner.
    const creator = await getSessionUser();

    const input: CreateProjectInput = {
      project_id: body.project_id,
      name: body.name,
      initialPrompt: body.initialPrompt || body.initial_prompt,
      preferredCli,
      selectedModel: normalizeModelId(preferredCli, requestedModel ?? getDefaultModelForCli(preferredCli)),
      description: body.description,
      templateType: isValidStack(rawStack) ? rawStack : undefined,
      ownerId: creator?.id ?? null,
    };

    // Validation
    if (!input.project_id || !input.name) {
      return createErrorResponse('project_id and name are required', undefined, 400);
    }
    // project_id becomes a filesystem path segment (repoPath, checkpoints GIT_DIR,
    // asset dirs). Constrain it to a safe slug so a value like "../../x" can't
    // plant a worktree — and later a `git clean -fd` — outside the sandbox.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.project_id)) {
      return createErrorResponse('project_id must be 1-64 chars: letters, digits, hyphen, underscore', undefined, 400);
    }

    const project = await createProject(input);

    // Optionally seed the project with a chosen design skill. Done after
    // creation (not inside createProject) to avoid a project<->skills import
    // cycle, and best-effort so a design hiccup never fails project creation.
    const designId = typeof body.designId === 'string' ? body.designId : (typeof body.design_id === 'string' ? body.design_id : '');
    if (designId) {
      try {
        const { setActiveDesign } = await import('@/lib/services/design-skills');
        await setActiveDesign(project.id, designId);
      } catch (e) {
        console.error('[API] Failed to apply design to new project:', e);
      }
    }

    // Optional backend + database composition. Stored in the project's settings
    // JSON (no schema change); the backend is scaffolded into the repo now, and
    // the preview runs it as its own isolated service.
    const backendId = typeof body.backendId === 'string' ? body.backendId : (typeof body.backend_id === 'string' ? body.backend_id : '');
    const databaseId = typeof body.databaseId === 'string' ? body.databaseId : (typeof body.database_id === 'string' ? body.database_id : '');
    if (isValidBackend(backendId) || isValidDatabase(databaseId)) {
      try {
        const prev = project.settings ? JSON.parse(project.settings) : {};
        const nextSettings = {
          ...prev,
          ...(isValidBackend(backendId) ? { backendType: backendId } : {}),
          ...(isValidDatabase(databaseId) ? { databaseType: databaseId } : {}),
        };
        // Scaffold the backend BEFORE persisting, so settings never claim a
        // backend the repo doesn't actually have (mirrors the containers route).
        if (isValidBackend(backendId) && project.repoPath) {
          const { scaffoldBackend } = await import('@/lib/utils/scaffold-backend');
          await scaffoldBackend(path.resolve(project.repoPath), backendId);
        }
        // Postgres: a PER-PROJECT CONTAINER database (own container on the project's
        // internal net, reachable only by this project) when isolation is available;
        // otherwise the legacy Coolify host DB.
        if (databaseId === 'postgres') {
          try {
            const { managedContainersEnabled, ensurePostgresService } = await import('@/lib/services/managed-containers');
            if (managedContainersEnabled()) {
              await ensurePostgresService(project.id);
            } else {
              const { provisionPostgres } = await import('@/lib/services/database');
              await provisionPostgres(project.id);
            }
          } catch (e) { console.error('[API] database provisioning failed:', e); }
        }
        await prisma.project.update({ where: { id: project.id }, data: { settings: JSON.stringify(nextSettings) } });
        (project as { settings?: string | null }).settings = JSON.stringify(nextSettings);
        return createSuccessResponse(serializeProject(project), 201); // re-serialize with the new settings
      } catch (e) {
        console.error('[API] Failed to apply project composition:', e);
      }
    }

    return createSuccessResponse(serializeProject(project), 201);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to create project');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
