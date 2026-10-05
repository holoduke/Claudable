/**
 * Organisatiebeheer (Prisma — Node only). Superadmin-only aan de API-kant.
 *
 * Organisaties zijn de tenant-grens voor het klantportaal: leden (OrgMember)
 * met rol eigenaar | beheerder | lid, en projecten hangen aan precies één org.
 * Vangrails hier: een org met projecten of leden kan niet weg, en de laatste
 * eigenaar van een org kan niet gedegradeerd of verwijderd worden.
 */
import { prisma } from '@/lib/db/client';
import { canActorSetRole, type OrgActor, type OrgRole } from '@/lib/services/org-access';
import { recordAudit, type AuditActor } from '@/lib/services/audit';
import { addedToOrgEmail, inviteEmail, sendMail } from '@/lib/services/mail';

/** Who performs a mutation; drives the role policy in org-access.ts and the audit trail. */
export type MemberActor = Pick<OrgActor, 'superadmin' | 'role'> & { user?: AuditActor | null };
const SUPERADMIN: MemberActor = { superadmin: true, role: null };

/** How long an invitation stays valid. */
export const INVITE_TTL_DAYS = 14;

/**
 * Every refusal from this module carries a stable machine `code` (mapped to a
 * translated sentence in the UI) and an HTTP `status`; `message` is English
 * for logs / API clients that don't translate.
 */
export type OrgErrorCode =
  | 'org_name_required' | 'org_invalid_type' | 'org_invalid_domain' | 'org_domain_exists'
  | 'org_not_found' | 'org_has_projects' | 'org_has_members'
  | 'invalid_role' | 'invalid_email' | 'already_member' | 'owner_required'
  | 'invite_not_found' | 'invite_already_accepted' | 'membership_not_found' | 'last_owner';

export class OrgError extends Error {
  constructor(readonly code: OrgErrorCode, message: string, readonly status: number = 400) {
    super(message);
    this.name = 'OrgError';
  }
}
class OrgPolicyError extends OrgError {
  constructor(message: string) { super('owner_required', message, 403); this.name = 'OrgPolicyError'; }
}
export function isOrgPolicyError(e: unknown): boolean { return e instanceof OrgPolicyError; }
export function isOrgError(e: unknown): e is OrgError { return e instanceof OrgError; }

/** Prisma unique violation on Organization.domain → a typed OrgError (else unchanged). */
export function toOrgError(e: unknown): unknown {
  if (e instanceof Error && (e as { code?: string }).code === 'P2002') {
    return new OrgError('org_domain_exists', 'An organisation with this domain already exists', 409);
  }
  return e;
}

function assertPolicy(actor: MemberActor, targetRole: OrgRole | null, newRole: OrgRole | null) {
  if (!canActorSetRole(actor, targetRole, newRole)) {
    throw new OrgPolicyError('Only an owner can add, change or remove owners');
  }
}

export const ORG_TYPES = ['intern', 'klant'] as const;
export const ORG_MEMBER_ROLES = ['eigenaar', 'beheerder', 'lid'] as const;
export type OrgType = (typeof ORG_TYPES)[number];
export type OrgMemberRole = (typeof ORG_MEMBER_ROLES)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertType(type: string): asserts type is OrgType {
  if (!ORG_TYPES.includes(type as OrgType)) {
    throw new OrgError('org_invalid_type', `Organisation type must be 'intern' or 'klant'`);
  }
}

function assertRole(role: string): asserts role is OrgMemberRole {
  if (!ORG_MEMBER_ROLES.includes(role as OrgMemberRole)) {
    throw new OrgError('invalid_role', `Role must be 'eigenaar', 'beheerder' or 'lid'`);
  }
}

/** Domein normaliseren; lege string wordt null (klant-orgs hebben er vaak geen). */
function normalizeDomain(domain?: string | null): string | null {
  const d = (domain ?? '').trim().toLowerCase();
  if (!d) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
    throw new OrgError('org_invalid_domain', 'Invalid domain (expected e.g. customer.com)');
  }
  return d;
}

export async function listOrgs() {
  const orgs = await prisma.organization.findMany({
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { members: true, projects: true } }, claudeCredential: { select: { label: true, createdAt: true } } },
  });
  return orgs.map((o) => ({
    id: o.id,
    name: o.name,
    type: o.type,
    domain: o.domain,
    canCreateProjects: o.canCreateProjects,
    allowOwnToken: o.allowOwnToken,
    claudeCredential: o.claudeCredential ? { label: o.claudeCredential.label, since: o.claudeCredential.createdAt } : null,
    createdAt: o.createdAt,
    memberCount: o._count.members,
    projectCount: o._count.projects,
  }));
}

export async function createOrg(
  input: { name: string; type?: string; domain?: string | null },
  actor?: AuditActor | null,
) {
  const name = input.name?.trim();
  if (!name) throw new OrgError('org_name_required', 'Name is required');
  const type = input.type?.trim() || 'klant';
  assertType(type);
  const org = await prisma.organization.create({
    data: { name, type, domain: normalizeDomain(input.domain) },
  });
  await recordAudit({ orgId: org.id, actor, action: 'org.created', targetType: 'org', targetId: org.id, meta: { name, type, domain: org.domain } });
  return org;
}

export async function updateOrg(
  id: string,
  input: { name?: string; type?: string; domain?: string | null; canCreateProjects?: boolean; allowOwnToken?: boolean },
  actor?: AuditActor | null,
) {
  const data: { name?: string; type?: string; domain?: string | null; canCreateProjects?: boolean; allowOwnToken?: boolean } = {};
  if (typeof input.canCreateProjects === 'boolean') data.canCreateProjects = input.canCreateProjects;
  if (typeof input.allowOwnToken === 'boolean') data.allowOwnToken = input.allowOwnToken;
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new OrgError('org_name_required', 'Name cannot be empty');
    data.name = name;
  }
  if (input.type !== undefined) {
    const type = input.type.trim();
    assertType(type);
    data.type = type;
  }
  if (input.domain !== undefined) data.domain = normalizeDomain(input.domain);
  const org = await prisma.organization.update({ where: { id }, data });
  await recordAudit({ orgId: id, actor, action: 'org.updated', targetType: 'org', targetId: id, meta: data });
  return org;
}

export async function deleteOrg(id: string, actor?: AuditActor | null) {
  const counts = await prisma.organization.findUnique({
    where: { id },
    include: { _count: { select: { members: true, projects: true, users: true } } },
  });
  if (!counts) throw new OrgError('org_not_found', 'Organisation not found', 404);
  if (counts._count.projects > 0) {
    throw new OrgError('org_has_projects', `Cannot delete: ${counts._count.projects} project(s) still belong to this organisation`, 409);
  }
  if (counts._count.members > 0 || counts._count.users > 0) {
    throw new OrgError('org_has_members', 'Cannot delete: the organisation still has members', 409);
  }
  await prisma.organization.delete({ where: { id } });
  // orgId is nulled by the cascade; keep the name in meta so the trail stays readable.
  await recordAudit({ orgId: null, actor, action: 'org.deleted', targetType: 'org', targetId: id, meta: { name: counts.name } });
}

export async function listOrgMembers(orgId: string) {
  const members = await prisma.orgMember.findMany({
    where: { orgId },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });
  return members.map((m) => ({
    userId: m.userId,
    email: m.user.email,
    name: m.user.name,
    image: m.user.image,
    role: m.role,
    isActive: m.user.isActive,
    since: m.createdAt,
  }));
}

/**
 * Lid toevoegen op e-mailadres (elk domein). Bestaat de gebruiker al (bijv. een
 * collega), dan direct een lidmaatschap erbij. Een onbekend adres krijgt een
 * UITNODIGING (OrgInvite, 14 dagen geldig): de gebruiker ontstaat pas bij de
 * eerste Google-login met dat adres (provision.ts) — geen slapende accounts meer.
 */
export async function addOrgMember(orgId: string, email: string, role: string, actor: MemberActor = SUPERADMIN) {
  assertRole(role);
  const lower = email.trim().toLowerCase();
  if (!EMAIL_RE.test(lower)) throw new OrgError('invalid_email', 'A valid e-mail address is required');

  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new OrgError('org_not_found', 'Organisation not found', 404);

  const user = await prisma.user.findUnique({ where: { email: lower } });
  const existing = user
    ? await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId, userId: user.id } } })
    : null;
  // Already a member: never change the role through this path (it would skip
  // the last-owner guard and demote silently). The role menu in the list is
  // the one place for that.
  if (existing) throw new OrgError('already_member', `${lower} is already a member of this organisation — change the role in the member list`, 409);
  assertPolicy(actor, null, role);

  if (!user) {
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const invite = await prisma.orgInvite.upsert({
      where: { orgId_email: { orgId, email: lower } },
      update: { role, expiresAt, revokedAt: null, acceptedAt: null, invitedById: actor.user?.id ?? null },
      create: { orgId, email: lower, role, expiresAt, invitedById: actor.user?.id ?? null },
    });
    // Best-effort e-mail; the invitation stands either way (the UI shows whether it went out).
    const mail = await sendMail(inviteEmail({ to: lower, orgName: org.name, role, invitedBy: actor.user?.email, expiresAt }));
    await recordAudit({ orgId, actor: actor.user, action: 'org.invite.created', targetType: 'invite', targetId: invite.id, meta: { email: lower, role, expiresAt, emailSent: mail.sent, ...(mail.sent ? {} : { emailReason: mail.reason }) } });
    return { invited: true as const, inviteId: invite.id, email: lower, role, expiresAt, emailSent: mail.sent };
  }

  await prisma.orgMember.upsert({
    where: { orgId_userId: { orgId, userId: user.id } },
    update: { role },
    create: { orgId, userId: user.id, role },
  });
  const mail = await sendMail(addedToOrgEmail({ to: user.email, orgName: org.name, role, addedBy: actor.user?.email }));
  await recordAudit({
    orgId, actor: actor.user,
    action: 'org.member.added',
    targetType: 'user', targetId: user.id,
    meta: { email: user.email, role, emailSent: mail.sent },
  });
  return { invited: false as const, userId: user.id, email: user.email, role, emailSent: mail.sent };
}

/** Openstaande (en recent verlopen/ingetrokken) uitnodigingen van een org. */
export async function listOrgInvites(orgId: string) {
  const rows = await prisma.orgInvite.findMany({
    where: { orgId, acceptedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { invitedBy: { select: { email: true, name: true } } },
  });
  const now = Date.now();
  return rows.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    invitedBy: i.invitedBy?.name || i.invitedBy?.email || null,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    status: i.revokedAt ? 'ingetrokken' : i.expiresAt.getTime() < now ? 'verlopen' : 'open',
  }));
}

export async function revokeOrgInvite(orgId: string, inviteId: string, actor: MemberActor = SUPERADMIN) {
  const invite = await prisma.orgInvite.findFirst({ where: { id: inviteId, orgId } });
  if (!invite) throw new OrgError('invite_not_found', 'Invitation not found', 404);
  if (invite.acceptedAt) throw new OrgError('invite_already_accepted', 'Invitation has already been accepted', 409);
  assertPolicy(actor, null, invite.role as OrgRole);
  await prisma.orgInvite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
  await recordAudit({ orgId, actor: actor.user, action: 'org.invite.revoked', targetType: 'invite', targetId: invite.id, meta: { email: invite.email, role: invite.role } });
}

/** De laatste eigenaar mag niet weg of omlaag — anders is de org stuurloos. */
export async function assertNotLastOwner(orgId: string, userId: string) {
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
  });
  if (member?.role !== 'eigenaar') return;
  const owners = await prisma.orgMember.count({ where: { orgId, role: 'eigenaar' } });
  if (owners <= 1) {
    throw new OrgError('last_owner', 'This is the last owner of the organisation — appoint another owner first', 409);
  }
}

export async function updateOrgMemberRole(orgId: string, userId: string, role: string, actor: MemberActor = SUPERADMIN) {
  assertRole(role);
  const current = await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId, userId } } });
  if (!current) throw new OrgError('membership_not_found', 'Membership not found', 404);
  assertPolicy(actor, current.role as OrgRole, role);
  if (role !== 'eigenaar') await assertNotLastOwner(orgId, userId);
  const updated = await prisma.orgMember.update({
    where: { orgId_userId: { orgId, userId } },
    data: { role },
  });
  await recordAudit({ orgId, actor: actor.user, action: 'org.member.role_changed', targetType: 'user', targetId: userId, meta: { from: current.role, role } });
  return updated;
}

export async function removeOrgMember(orgId: string, userId: string, actor: MemberActor = SUPERADMIN) {
  const current = await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId, userId } } });
  if (!current) throw new OrgError('membership_not_found', 'Membership not found', 404);
  assertPolicy(actor, current.role as OrgRole, null);
  await assertNotLastOwner(orgId, userId);
  // Definitief: provisioning maakt lidmaatschappen niet meer opnieuw aan bij
  // een volgende sign-in. Wie zo zijn laatste org verliest, kan pas weer
  // inloggen na een nieuwe uitnodiging (provision.ts / auth jwt-callback).
  await prisma.$transaction([
    prisma.orgMember.delete({ where: { orgId_userId: { orgId, userId } } }),
    // Per-project assignments inside this org go with the membership.
    prisma.projectMember.deleteMany({ where: { userId, project: { orgId } } }),
  ]);
  await recordAudit({ orgId, actor: actor.user, action: 'org.member.removed', targetType: 'user', targetId: userId, meta: { role: current.role } });
}

/**
 * Refuse when `userId` is the last owner of ANY organisation — used before an
 * account is deleted, which would otherwise leave that org without an owner.
 */
export async function assertNotLastOwnerOfAnyOrg(userId: string) {
  const owned = await prisma.orgMember.findMany({ where: { userId, role: 'eigenaar' }, select: { orgId: true } });
  for (const { orgId } of owned) await assertNotLastOwner(orgId, userId);
}
