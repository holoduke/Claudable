/**
 * Sign-in allowlist + user provisioning (Prisma — Node only).
 *
 * Allowed to sign in if: the email is on an allowed domain (auto-provisioned), OR
 * a User row already exists (an admin pre-added an external email). Everything is
 * provisioned into the single organization for now (multi-org-ready model).
 */
import { prisma } from '@/lib/db/client';

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

function emailDomainAllowed(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return !!domain && allowedDomains().includes(domain);
}

/** The single org (created on demand). Keyed by the primary allowed domain. */
async function ensureOrg() {
  const domain = primaryDomain();
  // upsert is race-safe for concurrent first sign-ins (vs findUnique-then-create).
  return prisma.organization.upsert({
    where: { domain },
    update: {},
    create: { name: DEFAULT_ORG_NAME, domain },
  });
}

/** Whether this email may sign in at all. */
export async function isSignInAllowed(email: string): Promise<boolean> {
  if (emailDomainAllowed(email)) return true;
  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  return !!existing;
}

/**
 * Create/update the user on sign-in. Returns the user (with role/isActive).
 * The configured BOOTSTRAP_ADMIN_EMAIL is promoted to admin (no lockout).
 */
export async function provisionUser(
  email: string,
  name?: string | null,
  image?: string | null,
) {
  const lower = email.toLowerCase();
  const bootstrap = !!process.env.BOOTSTRAP_ADMIN_EMAIL
    && lower === process.env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
  const org = await ensureOrg();

  // upsert avoids a TOCTOU race between concurrent first sign-ins. The bootstrap
  // admin is always (re)promoted AND reactivated, so they can never be locked
  // out by a deactivation/demotion — their next sign-in restores access.
  return prisma.user.upsert({
    where: { email: lower },
    update: {
      name: name ?? undefined,
      image: image ?? undefined,
      lastLoginAt: new Date(),
      ...(bootstrap ? { role: 'admin', isActive: true } : {}),
    },
    create: {
      email: lower,
      name: name ?? null,
      image: image ?? null,
      role: bootstrap ? 'admin' : 'user',
      orgId: org.id,
      isActive: true,
      lastLoginAt: new Date(),
    },
  });
}
