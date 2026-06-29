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

export function emailDomainAllowed(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return !!domain && allowedDomains().includes(domain);
}

/** The single org (created on demand). Keyed by the primary allowed domain. */
export async function ensureOrg() {
  const domain = primaryDomain();
  const existing = await prisma.organization.findUnique({ where: { domain } });
  if (existing) return existing;
  return prisma.organization.create({ data: { name: DEFAULT_ORG_NAME, domain } });
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
  const bootstrap = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: lower } });

  if (existing) {
    return prisma.user.update({
      where: { email: lower },
      data: {
        name: name ?? existing.name,
        image: image ?? existing.image,
        lastLoginAt: new Date(),
        ...(lower === bootstrap && existing.role !== 'admin' ? { role: 'admin' } : {}),
      },
    });
  }

  const org = await ensureOrg();
  return prisma.user.create({
    data: {
      email: lower,
      name: name ?? null,
      image: image ?? null,
      role: lower === bootstrap ? 'admin' : 'user',
      orgId: org.id,
      isActive: true,
      lastLoginAt: new Date(),
    },
  });
}
