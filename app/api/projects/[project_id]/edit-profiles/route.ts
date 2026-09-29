/**
 * Edit profiles for a project (see lib/services/edit-profiles.ts).
 *   GET  -> { me, profiles, canManage, config?, people? }   (config/people for managers only)
 *   PUT  -> { default, members, custom }                     (owner/admin; staff-only in customer projects)
 */
import { NextRequest } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getSessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/client';
import { recordAudit } from '@/lib/services/audit';
import {
  PROFILE_IDS, builtinProfile, editProfileConfigSchema, getEditProfileConfig, profileFor, resolveEditProfile,
  saveEditProfileConfig, type BuiltinProfileId, type EditProfileConfig,
} from '@/lib/services/edit-profiles';
import { requireProjectManager } from '@/lib/services/project-access';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ project_id: string }> }

const MAX_PEOPLE = 200;

function profileList(config: EditProfileConfig) {
  return PROFILE_IDS.map((id) => (id === 'custom' ? { ...profileFor('custom', config), defined: Boolean(config.custom) } : { ...builtinProfile(id as BuiltinProfileId), defined: true }));
}

/** Everyone who can write the project and could get a profile, with whether they are exempt. */
async function projectPeople(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true, orgId: true, visibility: true } });
  if (!project) return [];
  const users = project.visibility === 'restricted'
    ? (await prisma.projectMember.findMany({ where: { projectId, role: 'editor' }, include: { user: true }, take: MAX_PEOPLE })).map((m) => m.user)
    : project.orgId
      ? (await prisma.orgMember.findMany({ where: { orgId: project.orgId }, include: { user: true }, take: MAX_PEOPLE })).map((m) => m.user)
      : [];
  return Promise.all(users.map(async (u) => {
    const { source } = await resolveEditProfile(projectId, u.id);
    return { id: u.id, email: u.email, name: u.name, image: u.image, exempt: source === 'exempt', owner: u.id === project.ownerId };
  }));
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { project_id } = await params;
    const denied = await denyUnlessProjectAccess(project_id);
    if (denied) return denied;
    const user = await getSessionUser();
    const config = await getEditProfileConfig(project_id);
    const me = await resolveEditProfile(project_id, user?.id);
    const manager = await requireProjectManager(project_id);
    if (!manager.ok) {
      return createSuccessResponse({ me, canManage: false, profiles: profileList(config) });
    }
    return createSuccessResponse({ me, canManage: true, profiles: profileList(config), config, people: await projectPeople(project_id) });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to load edit profiles');
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const { project_id } = await params;
    const gate = await requireProjectManager(project_id);
    if (!gate.ok) return createErrorResponse(gate.code, gate.message, gate.status);
    const body = await req.json().catch(() => null);
    const parsed = editProfileConfigSchema.safeParse(body);
    if (!parsed.success) {
      return createErrorResponse('invalid_input', parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; '), 400);
    }
    const next = parsed.data;
    const usesCustom = next.default === 'custom' || Object.values(next.members).includes('custom');
    if (usesCustom && !next.custom) return createErrorResponse('invalid_input', 'Define the custom profile before assigning it', 400);
    // Only keep overrides for real users (a stale id would silently linger otherwise).
    const ids = Object.keys(next.members);
    const known = new Set((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((u) => u.id));
    const members = Object.fromEntries(Object.entries(next.members).filter(([id]) => known.has(id)));
    const saved = await saveEditProfileConfig(project_id, { ...next, members });
    await recordAudit({
      orgId: gate.project.orgId,
      actor: gate.user,
      action: 'project.edit_profiles_changed',
      targetType: 'project',
      targetId: project_id,
      meta: { default: saved.default, overrides: Object.keys(saved.members).length, custom: Boolean(saved.custom) },
    });
    return createSuccessResponse({ config: saved, profiles: profileList(saved), people: await projectPeople(project_id) });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to save edit profiles');
  }
}
