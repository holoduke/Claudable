/**
 * Projects API Routes
 * GET /api/projects - Get all projects
 * POST /api/projects - Create new project
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAllProjects, createProject } from '@/lib/services/project';
import type { CreateProjectInput } from '@/types/backend';
import { serializeProjects, serializeProject } from '@/lib/serializers/project';
import { getDefaultModelForCli, normalizeModelId } from '@/lib/constants/cliModels';
import { createErrorResponse, handleApiError } from '@/lib/utils/api-response';
import { getSessionUser, authEnabled } from '@/lib/auth/session';
import { accessibleProjectIds, canManageProject } from '@/lib/services/project-access';
import { isInternalUser, CUSTOMER_ORG_TYPE } from '@/lib/services/tenant-policy';
import { orgIdsFor, orgAllowsProjectCreation } from '@/lib/services/org-access';
import { isValidStack } from '@/lib/config/stacks';
import { isValidBackend, getBackendStack } from '@/lib/config/backend-stacks';
import { getDatabaseOption, isValidDatabase } from '@/lib/config/databases';
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
      if (!me) return listResponse([], false);
      // getAllProjects spreads the full Prisma row, so ownerId/orgId/visibility
      // exist at runtime even though the backend Project type omits them.
      const allowed = await accessibleProjectIds(me, projects as unknown as Parameters<typeof accessibleProjectIds>[1]);
      const internal = await isInternalUser(me);
      const items = projects
        .filter((p) => allowed.has(p.id))
        .map((p) => ({ ...serializeProject(p), canManage: canManageListed(me, p as unknown as ListedRow, internal) }));
      return listResponse(items, !!process.env.XAI_API_KEY && internal);
    }
    const items = serializeProjects(projects).map((p) => ({ ...p, canManage: true }));
    return listResponse(items, !!process.env.XAI_API_KEY);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to fetch projects');
  }
}

type ListedRow = { ownerId: string | null; organization?: { type?: string } | null };

/**
 * Rename/delete tier for the sidebar — mirrors denyUnlessProjectAccess({ manage })
 * in [project_id]/route.ts: owner or global admin, and in a customer project only
 * New Story staff.
 */
function canManageListed(me: { id: string; role: string }, row: ListedRow, internal: boolean): boolean {
  if (!canManageProject(me as Parameters<typeof canManageProject>[0], row)) return false;
  return row.organization?.type !== CUSTOMER_ORG_TYPE || internal;
}

/**
 * The list plus light, non-sensitive capability flags for the start screen.
 * `imageGenAvailable`: the shared xAI key exists AND the user may use it (not a
 * customer-only user — customer projects never bill New Story's key). The
 * client still hides it when the picked org is a customer org.
 */
function listResponse(data: unknown[], imageGenAvailable: boolean) {
  return NextResponse.json({ success: true, data, meta: { imageGenAvailable } });
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

    // Tenant: an org the creator is a MEMBER of. The client may pick one of
    // their orgs (multi-org users, e.g. staff working for a customer); default
    // is the home org when they belong to it, else their first membership.
    let orgId: string | null = null;
    if (creator) {
      const isStaff = creator.role === 'admin';
      const memberships = await orgIdsFor(creator.id);
      const requested = typeof body.orgId === 'string' ? body.orgId : (typeof body.org_id === 'string' ? body.org_id : '');
      if (requested) {
        // Staff may file a project under any org; everyone else only under their own.
        if (!isStaff && !memberships.has(requested)) {
          return createErrorResponse('forbidden', 'You are not a member of that organisation', 403);
        }
        orgId = requested;
      } else {
        // Default: the home org when the user belongs to it and it allows creation,
        // else the first membership that does. Staff default to their home org.
        const candidates = memberships.has(creator.orgId) ? [creator.orgId, ...memberships] : [...memberships];
        if (isStaff) {
          orgId = candidates[0] ?? creator.orgId;
        } else {
          for (const id of candidates) { if (await orgAllowsProjectCreation(id)) { orgId = id; break; } }
          if (!orgId && candidates.length) {
            return createErrorResponse('org_cannot_create', 'Your organisation is not allowed to create new projects. Ask New Story.', 403);
          }
        }
      }
      if (!orgId) {
        return createErrorResponse('forbidden', 'You are not a member of any organisation', 403);
      }
      // Superadmin-controlled per-org switch (staff exempt so they can set up
      // projects for an org that customers may not extend).
      if (!isStaff && !(await orgAllowsProjectCreation(orgId))) {
        return createErrorResponse('org_cannot_create', 'Your organisation is not allowed to create new projects. Ask New Story.', 403);
      }
    }

    const input: CreateProjectInput = {
      project_id: body.project_id,
      name: body.name,
      initialPrompt: body.initialPrompt || body.initial_prompt,
      preferredCli,
      selectedModel: normalizeModelId(preferredCli, requestedModel ?? getDefaultModelForCli(preferredCli)),
      description: body.description,
      templateType: isValidStack(rawStack) ? rawStack : undefined,
      ownerId: creator?.id ?? null,
      // Validated above against the creator's memberships — never an org they
      // don't belong to.
      orgId,
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
    // Containers, networks and preview routes are named after a slug of the id. Refuse an
    // id whose runtime names would collide with an existing project's (e.g. "Foo" vs "foo",
    // or "x-api" vs the backend of "x"): the projects would share — and could stop or
    // delete — each other's containers and preview route.
    {
      const { sharedRuntimeNames } = await import('@/lib/services/project-wipe');
      const existingIds = (await prisma.project.findMany({ select: { id: true } })).map((p) => p.id);
      if (existingIds.includes(input.project_id) || sharedRuntimeNames(input.project_id, existingIds).size > 0) {
        return createErrorResponse('project_id conflicts with an existing project; choose another id', undefined, 409);
      }
    }

    // Refuse a database this server can't provision BEFORE creating anything
    // (MySQL exists only as a per-project container — no host fallback).
    const databaseId = typeof body.databaseId === 'string' ? body.databaseId : (typeof body.database_id === 'string' ? body.database_id : '');
    if (isValidDatabase(databaseId)) {
      const { databaseAvailable } = await import('@/lib/services/project-database-provision');
      if (!(await databaseAvailable(databaseId))) {
        return createErrorResponse('database_unavailable', `${getDatabaseOption(databaseId)?.name ?? databaseId} is not available on this server (it needs managed containers). Pick another database.`, 400);
      }
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

    // Follow-up steps are best-effort (the project already exists), but their
    // failures are reported back as human-readable warnings so the start screen
    // can tell the user instead of silently dropping a backend or database.
    const warnings: CreateWarning[] = [];

    // Optional image-generation utility picked on the start screen. 'grok'
    // connects the per-project images capability (shared xAI key unless the
    // project later sets its own). Best-effort — never fails project creation.
    const imageProvider = typeof body.imageProvider === 'string' ? body.imageProvider : (typeof body.image_provider === 'string' ? body.image_provider : '');
    if (imageProvider === 'grok') {
      try {
        const { connectImages, getImagesConnection } = await import('@/lib/services/capabilities/images');
        await connectImages(project.id);
        const status = await getImagesConnection(project.id);
        if (!status.hasOwnKey && !status.globalAvailable) {
          warnings.push({ code: 'image_gen_no_key', message: 'Image generation was connected, but no xAI key is available for this project. Add one in Project Settings → Services.' });
        }
      } catch (e) {
        console.error('[API] Failed to connect image generation to new project:', e);
        warnings.push({ code: 'image_gen_failed', message: 'Image generation could not be connected. You can connect it later in Project Settings.' });
      }
    }

    // Optional backend + database composition. Stored in the project's settings
    // JSON (no schema change); the backend is scaffolded into the repo now, and
    // the preview runs it as its own isolated service.
    const backendId = typeof body.backendId === 'string' ? body.backendId : (typeof body.backend_id === 'string' ? body.backend_id : '');
    if (isValidBackend(backendId) || isValidDatabase(databaseId)) {
      let backendOk = isValidBackend(backendId);
      // Scaffold the backend BEFORE persisting, so settings never claim a
      // backend the repo doesn't actually have (mirrors the containers route).
      if (backendOk && project.repoPath) {
        try {
          const { scaffoldBackend } = await import('@/lib/utils/scaffold-backend');
          await scaffoldBackend(path.resolve(project.repoPath), backendId);
        } catch (e) {
          console.error('[API] backend scaffold failed:', e);
          backendOk = false;
          warnings.push({ code: 'backend_scaffold_failed', message: `The ${getBackendStack(backendId)?.name ?? backendId} backend could not be set up. The project was created without a backend; you can add one later in Project Settings.` });
        }
      }
      // Postgres / MySQL: a PER-PROJECT CONTAINER database (own container on the
      // project's internal net, reachable only by this project) when isolation is
      // available; Postgres otherwise falls back to the legacy Coolify host DB.
      if (isValidDatabase(databaseId)) {
        try {
          const { provisionProjectDatabase } = await import('@/lib/services/project-database-provision');
          await provisionProjectDatabase(project.id, databaseId);
        } catch (e) {
          console.error('[API] database provisioning failed:', e);
          warnings.push({ code: 'database_provision_failed', message: `The ${getDatabaseOption(databaseId)?.name ?? databaseId} database could not be provisioned yet. Retry it from Project Settings → Database.` });
        }
      }
      try {
        const prev = project.settings ? JSON.parse(project.settings) : {};
        const nextSettings = {
          ...prev,
          ...(backendOk ? { backendType: backendId } : {}),
          ...(isValidDatabase(databaseId) ? { databaseType: databaseId } : {}),
        };
        const settings = JSON.stringify(nextSettings);
        await prisma.project.update({ where: { id: project.id }, data: { settings } });
        return createdResponse({ ...project, settings }, warnings); // re-serialize with the new settings
      } catch (e) {
        console.error('[API] Failed to apply project composition:', e);
        warnings.push({ code: 'composition_save_failed', message: 'The chosen backend/database could not be saved on the project. Set them again in Project Settings.' });
      }
    }

    return createdResponse(project, warnings);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to create project');
  }
}

interface CreateWarning { code: string; message: string }

/** 201 with the project, plus `warnings` (human-readable) and `warningCodes` (for i18n) when follow-ups failed. */
function createdResponse(project: Parameters<typeof serializeProject>[0], warnings: CreateWarning[]) {
  return NextResponse.json({
    success: true,
    data: serializeProject(project),
    warnings: warnings.map((w) => w.message),
    warningCodes: warnings.map((w) => w.code),
  }, { status: 201 });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
