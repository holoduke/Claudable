/**
 * Organisatiebeheer (Prisma — Node only). Superadmin-only aan de API-kant.
 *
 * Organisaties zijn de tenant-grens voor het klantportaal: leden (OrgMember)
 * met rol eigenaar | beheerder | lid, en projecten hangen aan precies één org.
 * Vangrails hier: een org met projecten of leden kan niet weg, en de laatste
 * eigenaar van een org kan niet gedegradeerd of verwijderd worden.
 */
import { prisma } from '@/lib/db/client';
import { addExternalUser } from '@/lib/services/users';
import { canActorSetRole, type OrgActor, type OrgRole } from '@/lib/services/org-access';

/** Who performs a member mutation; drives the role policy in org-access.ts. */
export type MemberActor = Pick<OrgActor, 'superadmin' | 'role'>;
const SUPERADMIN: MemberActor = { superadmin: true, role: null };

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

export async function createOrg(input: { name: string; type?: string; domain?: string | null }) {
  const name = input.name?.trim();
  if (!name) throw new Error('Naam is verplicht');
  const type = input.type?.trim() || 'klant';
  assertType(type);
  return prisma.organization.create({
    data: { name, type, domain: normalizeDomain(input.domain) },
  });
}

export async function updateOrg(
  id: string,
  input: { name?: string; type?: string; domain?: string | null },
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
  return prisma.organization.update({ where: { id }, data });
}

export async function deleteOrg(id: string) {
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
 * Lid toevoegen op e-mailadres. Bestaat de gebruiker al (bijv. een collega),
 * dan alleen een membership erbij; anders wordt een slapende externe gebruiker
 * aangemaakt (mag daarna via Google inloggen) met deze org als thuisorg.
 */
export async function addOrgMember(orgId: string, email: string, role: string, actor: MemberActor = SUPERADMIN) {
  assertRole(role);
  const lower = email.trim().toLowerCase();
  if (!EMAIL_RE.test(lower)) throw new Error('Een geldig e-mailadres is verplicht');

  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new Error('Organisatie niet gevonden');

  let user = await prisma.user.findUnique({ where: { email: lower } });
  const existing = user
    ? await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId, userId: user.id } } })
    : null;
  assertPolicy(actor, (existing?.role as OrgRole | undefined) ?? null, role);
  if (!user) {
    ({ user } = await addExternalUser(orgId, lower));
  }
  await prisma.orgMember.upsert({
    where: { orgId_userId: { orgId, userId: user.id } },
    update: { role },
    create: { orgId, userId: user.id, role },
  });
  return { userId: user.id, email: user.email };
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
  return prisma.orgMember.update({
    where: { orgId_userId: { orgId, userId } },
    data: { role },
  });
}

export async function removeOrgMember(orgId: string, userId: string, actor: MemberActor = SUPERADMIN) {
  const current = await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId, userId } } });
  if (!current) throw new Error('Lidmaatschap niet gevonden');
  assertPolicy(actor, current.role as OrgRole, null);
  await assertNotLastOwner(orgId, userId);
  // NB: is dit de thuisorg van de gebruiker (User.orgId), dan maakt een
  // volgende sign-in het lidmaatschap idempotent opnieuw aan (provision.ts).
  // Externe gebruikers echt buitensluiten doe je via Gebruikers → Deactivate.
  await prisma.orgMember.delete({ where: { orgId_userId: { orgId, userId } } });
}
