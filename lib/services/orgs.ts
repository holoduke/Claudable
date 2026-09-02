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

/** Who performs a mutation; drives the role policy in org-access.ts and the audit trail. */
export type MemberActor = Pick<OrgActor, 'superadmin' | 'role'> & { user?: AuditActor | null };
const SUPERADMIN: MemberActor = { superadmin: true, role: null };

/** How long an invitation stays valid. */
export const INVITE_TTL_DAYS = 14;

class OrgPolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'OrgPolicyError'; }
}
export function isOrgPolicyError(e: unknown): boolean { return e instanceof OrgPolicyError; }

function assertPolicy(actor: MemberActor, targetRole: OrgRole | null, newRole: OrgRole | null) {
  if (!canActorSetRole(actor, targetRole, newRole)) {
    throw new OrgPolicyError('Alleen een eigenaar kan eigenaren toevoegen, wijzigen of verwijderen');
  }
}

export const ORG_TYPES = ['intern', 'klant'] as const;
export const ORG_MEMBER_ROLES = ['eigenaar', 'beheerder', 'lid'] as const;
export type OrgType = (typeof ORG_TYPES)[number];
export type OrgMemberRole = (typeof ORG_MEMBER_ROLES)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertType(type: string): asserts type is OrgType {
  if (!ORG_TYPES.includes(type as OrgType)) {
    throw new Error(`Organisatietype moet 'intern' of 'klant' zijn`);
  }
}

function assertRole(role: string): asserts role is OrgMemberRole {
  if (!ORG_MEMBER_ROLES.includes(role as OrgMemberRole)) {
    throw new Error(`Rol moet 'eigenaar', 'beheerder' of 'lid' zijn`);
  }
}

/** Domein normaliseren; lege string wordt null (klant-orgs hebben er vaak geen). */
function normalizeDomain(domain?: string | null): string | null {
  const d = (domain ?? '').trim().toLowerCase();
  if (!d) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
    throw new Error('Domein is ongeldig (verwacht bijv. klant.nl)');
  }
  return d;
}

export async function listOrgs() {
  const orgs = await prisma.organization.findMany({
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { members: true, projects: true } } },
  });
  return orgs.map((o) => ({
    id: o.id,
    name: o.name,
    type: o.type,
    domain: o.domain,
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
  if (!name) throw new Error('Naam is verplicht');
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
  input: { name?: string; type?: string; domain?: string | null },
  actor?: AuditActor | null,
) {
  const data: { name?: string; type?: string; domain?: string | null } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error('Naam mag niet leeg zijn');
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
  if (!counts) throw new Error('Organisatie niet gevonden');
  if (counts._count.projects > 0) {
    throw new Error(`Kan niet verwijderen: er hangen nog ${counts._count.projects} project(en) aan deze organisatie`);
  }
  if (counts._count.members > 0 || counts._count.users > 0) {
    throw new Error('Kan niet verwijderen: de organisatie heeft nog leden');
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
  if (!EMAIL_RE.test(lower)) throw new Error('Een geldig e-mailadres is verplicht');

  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new Error('Organisatie niet gevonden');

  const user = await prisma.user.findUnique({ where: { email: lower } });
  const existing = user
    ? await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId, userId: user.id } } })
    : null;
  assertPolicy(actor, (existing?.role as OrgRole | undefined) ?? null, role);

  if (!user) {
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const invite = await prisma.orgInvite.upsert({
      where: { orgId_email: { orgId, email: lower } },
      update: { role, expiresAt, revokedAt: null, acceptedAt: null, invitedById: actor.user?.id ?? null },
      create: { orgId, email: lower, role, expiresAt, invitedById: actor.user?.id ?? null },
    });
    await recordAudit({ orgId, actor: actor.user, action: 'org.invite.created', targetType: 'invite', targetId: invite.id, meta: { email: lower, role, expiresAt } });
    return { invited: true as const, inviteId: invite.id, email: lower, role, expiresAt };
  }

  await prisma.orgMember.upsert({
    where: { orgId_userId: { orgId, userId: user.id } },
    update: { role },
    create: { orgId, userId: user.id, role },
  });
  await recordAudit({
    orgId, actor: actor.user,
    action: existing ? 'org.member.role_changed' : 'org.member.added',
    targetType: 'user', targetId: user.id,
    meta: { email: user.email, role, ...(existing ? { from: existing.role } : {}) },
  });
  return { invited: false as const, userId: user.id, email: user.email, role };
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
  if (!invite) throw new Error('Uitnodiging niet gevonden');
  if (invite.acceptedAt) throw new Error('Uitnodiging is al geaccepteerd');
  assertPolicy(actor, null, invite.role as OrgRole);
  await prisma.orgInvite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
  await recordAudit({ orgId, actor: actor.user, action: 'org.invite.revoked', targetType: 'invite', targetId: invite.id, meta: { email: invite.email, role: invite.role } });
}

/** De laatste eigenaar mag niet weg of omlaag — anders is de org stuurloos. */
async function assertNotLastOwner(orgId: string, userId: string) {
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
  });
  if (member?.role !== 'eigenaar') return;
  const owners = await prisma.orgMember.count({ where: { orgId, role: 'eigenaar' } });
  if (owners <= 1) {
    throw new Error('Dit is de laatste eigenaar van de organisatie — wijs eerst een andere eigenaar aan');
  }
}

export async function updateOrgMemberRole(orgId: string, userId: string, role: string, actor: MemberActor = SUPERADMIN) {
  assertRole(role);
  const current = await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId, userId } } });
  if (!current) throw new Error('Lidmaatschap niet gevonden');
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
  if (!current) throw new Error('Lidmaatschap niet gevonden');
  assertPolicy(actor, current.role as OrgRole, null);
  await assertNotLastOwner(orgId, userId);
  // Definitief: provisioning maakt lidmaatschappen niet meer opnieuw aan bij
  // een volgende sign-in. Wie zo zijn laatste org verliest, kan pas weer
  // inloggen na een nieuwe uitnodiging (provision.ts / auth jwt-callback).
  await prisma.orgMember.delete({ where: { orgId_userId: { orgId, userId } } });
  await recordAudit({ orgId, actor: actor.user, action: 'org.member.removed', targetType: 'user', targetId: userId, meta: { role: current.role } });
}
