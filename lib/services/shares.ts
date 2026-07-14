/**
 * Public share links: a revocable token that grants read + comment access to a
 * project's live preview without a Claudable account (for stakeholder review).
 */
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/db/client';

export async function getOrCreateShare(projectId: string): Promise<{ token: string }> {
  const existing = await prisma.projectShare.findUnique({ where: { projectId } });
  if (existing) return { token: existing.token };
  const token = randomBytes(18).toString('base64url');
  // upsert (not create) so two concurrent calls — e.g. a double-clicked Share
  // button — don't race the projectId @unique constraint into a P2002 500.
  const row = await prisma.projectShare.upsert({
    where: { projectId },
    update: {},
    create: { projectId, token },
  });
  return { token: row.token };
}

export async function getShare(projectId: string): Promise<{ token: string } | null> {
  const s = await prisma.projectShare.findUnique({ where: { projectId } });
  return s ? { token: s.token } : null;
}

export async function revokeShare(projectId: string): Promise<void> {
  await prisma.projectShare.deleteMany({ where: { projectId } });
}

// Optional expiry for share links. Default 0 = never expire (unchanged behavior);
// set SHARE_TTL_DAYS to auto-invalidate stakeholder links after N days.
const SHARE_TTL_DAYS = Number(process.env.SHARE_TTL_DAYS || 0);

/** Resolve a share token to its project id, or null if invalid/revoked/expired. */
export async function resolveShareToken(token: string): Promise<string | null> {
  if (!token || token.length < 10) return null;
  const s = await prisma.projectShare.findUnique({ where: { token }, select: { projectId: true, createdAt: true } });
  if (!s) return null;
  if (SHARE_TTL_DAYS > 0) {
    const ageMs = Date.now() - new Date(s.createdAt).getTime();
    if (ageMs > SHARE_TTL_DAYS * 24 * 60 * 60 * 1000) return null; // expired
  }
  return s.projectId;
}

/** True if the given token is a valid share for this project (guest access gate). */
export async function shareTokenGrants(projectId: string, token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  return (await resolveShareToken(token)) === projectId;
}
