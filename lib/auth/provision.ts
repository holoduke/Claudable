/**
 * Sign-in allowlist + user provisioning (Prisma — Node only).
 *
 * Who may sign in, and where a brand-new user lands:
 *
 *  1. A pending, unexpired invitation for the (Google-verified) e-mail address
 *     → the user is created in the inviting organisation with the invited role;
 *     every pending invite for that address is accepted in one go.
 *  2. Otherwise, the e-mail domain is in ALLOWED_EMAIL_DOMAINS (auto-join) AND
 *     an organisation carries exactly that domain → provisioned into THAT org
 *     as lid. An allowed domain without a matching org is refused (never
 *     silently filed under the primary org).
 *  3. Otherwise an existing, active user who still holds at least one org
 *     membership (or is a global admin) may sign in.
 *  4. Everyone else is refused.
 *
 * Memberships are created only when a user is created or accepts an invite —
 * never re-created on a routine sign-in. Removing someone from their last
 * organisation therefore really removes their access. The bootstrap admin is
 * the one exception: they are re-promoted, re-activated and kept a member of
 * the primary org on every sign-in so the instance can never lock itself out.
 */
import { prisma } from '@/lib/db/client';
import { recordAudit } from '@/lib/services/audit';

const DEFAULT_ORG_NAME = 'New Story';

function allowedDomains(): string[] {
  return (process.env.ALLOWED_EMAIL_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function primaryDomain(): string {
  return allowedDomains()[0] || 'example.com';
}

function emailDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

function isBootstrapAdmin(email: string): boolean {
  const configured = process.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase();
  return !!configured && email.toLowerCase() === configured;
}

/** The primary org (created on first run). Keyed by the primary allowed domain. */
export async function ensurePrimaryOrg() {
  const domain = primaryDomain();
  // upsert is race-safe for concurrent first sign-ins (vs findUnique-then-create).
  return prisma.organization.upsert({
    where: { domain },
    update: {},
    create: { name: DEFAULT_ORG_NAME, domain },
  });
}

/** The org an e-mail domain auto-joins, if that domain is allowed AND owned by an org. */
async function autoJoinOrg(email: string) {
  const domain = emailDomain(email);
  if (!domain || !allowedDomains().includes(domain)) return null;
  if (domain === primaryDomain()) return ensurePrimaryOrg();
  return prisma.organization.findUnique({ where: { domain } });
}

async function pendingInvites(email: string) {
  return prisma.orgInvite.findMany({
    where: { email: email.toLowerCase(), acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Legacy accounts (created before memberships existed) have User.orgId but no
 * OrgMember row. Distinguish them from people who were deliberately REMOVED:
 * removals are audited (org.member.removed). Only the former get their home
 * membership created here — once — so the "no resurrection" rule still holds.
 */
async function healLegacyMembership(user: { id: string; orgId: string; role: string }): Promise<boolean> {
  const removed = await prisma.auditEvent.findFirst({
    where: { action: 'org.member.removed', targetType: 'user', targetId: user.id, orgId: user.orgId },
    select: { id: true },
  });
  if (removed) return false;
  const org = await prisma.organization.findUnique({ where: { id: user.orgId }, select: { id: true } });
  if (!org) return false;
  await prisma.orgMember.upsert({
    where: { orgId_userId: { orgId: user.orgId, userId: user.id } },
    update: {},
    create: { orgId: user.orgId, userId: user.id, role: user.role === 'admin' ? 'beheerder' : 'lid' },
  });
  return true;
}

/** Whether this email may sign in at all (see the header for the rules). */
export async function isSignInAllowed(email: string): Promise<boolean> {
  const lower = email.toLowerCase();
  if (isBootstrapAdmin(lower)) return true;
  const existing = await prisma.user.findUnique({
    where: { email: lower },
    include: { _count: { select: { orgMemberships: true } } },
  });
  if (existing) {
    if (!existing.isActive) return false;
    if (existing.role === 'admin' || existing._count.orgMemberships > 0) return true;
    if ((await pendingInvites(lower)).length > 0) return true; // removed → re-invited
    return healLegacyMembership(existing); // pre-membership account → heal once
  }
  if ((await pendingInvites(lower)).length > 0) return true;
  return !!(await autoJoinOrg(lower));
}

/**
 * Create/update the user on sign-in. Returns the user (with role/isActive).
 * Assumes isSignInAllowed() already passed.
 */
export async function provisionUser(
  email: string,
  name?: string | null,
  image?: string | null,
) {
  const lower = email.toLowerCase();
  const bootstrap = isBootstrapAdmin(lower);
  const invites = await pendingInvites(lower);

  let user = await prisma.user.findUnique({ where: { email: lower } });

  if (user) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: name ?? undefined,
        image: image ?? undefined,
        lastLoginAt: new Date(),
        // The bootstrap admin is always (re)promoted AND reactivated, so they can
        // never be locked out by a deactivation/demotion.
        ...(bootstrap ? { role: 'admin', isActive: true } : {}),
      },
    });
  } else {
    // New user: home org = the first inviting org, else the auto-join org.
    const homeOrg = invites.length
      ? await prisma.organization.findUnique({ where: { id: invites[0].orgId } })
      : await autoJoinOrg(lower);
    if (!homeOrg) throw new Error(`No organisation to provision ${lower} into`);
    const autoRole = bootstrap ? 'beheerder' : 'lid';
    try {
      user = await prisma.user.create({
        data: {
          email: lower,
          name: name ?? null,
          image: image ?? null,
          role: bootstrap ? 'admin' : 'user',
          orgId: homeOrg.id,
          isActive: true,
          lastLoginAt: new Date(),
          // Auto-join membership only when there is no invite for this org —
          // invites (below) carry their own role.
          ...(invites.some((i) => i.orgId === homeOrg.id)
            ? {}
            : { orgMemberships: { create: { orgId: homeOrg.id, role: autoRole } } }),
        },
      });
    } catch (error) {
      // Two concurrent first sign-ins (double click, two tabs): the other one
      // won the insert — continue with that row instead of failing this login.
      if ((error as { code?: string })?.code !== 'P2002') throw error;
      user = await prisma.user.findUniqueOrThrow({ where: { email: lower } });
    }
  }

  // Accept every pending invite: membership with the invited role (an existing
  // membership keeps the higher of the two only if the invite is higher — we
  // simply apply the invite's role, which is what the inviter asked for).
  for (const invite of invites) {
    await prisma.orgMember.upsert({
      where: { orgId_userId: { orgId: invite.orgId, userId: user.id } },
      update: { role: invite.role },
      create: { orgId: invite.orgId, userId: user.id, role: invite.role },
    });
    await prisma.orgInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
    await recordAudit({
      orgId: invite.orgId,
      actor: { id: user.id, email: user.email },
      action: 'org.invite.accepted',
      targetType: 'user',
      targetId: user.id,
      meta: { email: user.email, role: invite.role, inviteId: invite.id },
    });
  }

  // Bootstrap admin: guaranteed membership of the primary org (self-healing).
  if (bootstrap) {
    const primary = await ensurePrimaryOrg();
    await prisma.orgMember.upsert({
      where: { orgId_userId: { orgId: primary.id, userId: user.id } },
      update: {},
      create: { orgId: primary.id, userId: user.id, role: 'beheerder' },
    });
  }

  return user;
}
