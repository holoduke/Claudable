/**
 * Per-user Claude credentials (the subscription token from `claude setup-token`),
 * stored encrypted. A user owns their credential and may mark it `shareable` so
 * others in the org can pick it for a project. A project's agent runs use its
 * assigned credential (Project.claudeCredentialId); if none, the global env token.
 */
import { prisma } from '@/lib/db/client';
import { encrypt, decrypt } from '@/lib/crypto';
import type { ClaudeCredential } from '@prisma/client';

export interface CredentialView {
  id: string;
  label: string;
  shareable: boolean;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string;
  isMine: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

type WithOwner = ClaudeCredential & { owner?: { name: string | null; email: string } };

function view(c: WithOwner, meId: string): CredentialView {
  return {
    id: c.id,
    label: c.label,
    shareable: c.shareable,
    ownerId: c.ownerId,
    ownerName: c.owner?.name ?? null,
    ownerEmail: c.owner?.email ?? '',
    isMine: c.ownerId === meId,
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
  };
}

/** The current user's own credentials (token never returned). */
export async function listMyCredentials(userId: string): Promise<CredentialView[]> {
  const creds = await prisma.claudeCredential.findMany({
    where: { ownerId: userId },
    include: { owner: true },
    orderBy: { createdAt: 'desc' },
  });
  return creds.map((c) => view(c, userId));
}

/** Every Claude account in the org (admin view). Token never returned; `isMine`
 *  still marks the caller's own. Ordered mine-first, then by owner. */
export async function listOrgCredentials(orgId: string, meId: string): Promise<CredentialView[]> {
  const creds = await prisma.claudeCredential.findMany({
    where: { owner: { orgId } },
    include: { owner: true },
    orderBy: [{ createdAt: 'desc' }],
  });
  return creds
    .map((c) => view(c, meId))
    .sort((a, b) => {
      if (a.isMine !== b.isMine) return a.isMine ? -1 : 1;
      return (a.ownerName ?? a.ownerEmail).localeCompare(b.ownerName ?? b.ownerEmail);
    });
}

/** A single credential's view (no token), org-scoped. Null when missing/foreign-org. */
export async function getCredentialView(
  credentialId: string,
  me: { id: string; orgId: string },
): Promise<CredentialView | null> {
  const cred = await prisma.claudeCredential.findUnique({
    where: { id: credentialId },
    include: { owner: true },
  });
  if (!cred || cred.owner?.orgId !== me.orgId) return null;
  return view(cred, me.id);
}

/** Credentials a user may assign to a project: their own + shareable ones in the org. */
export async function listSelectableCredentials(user: { id: string; orgId: string }): Promise<CredentialView[]> {
  const creds = await prisma.claudeCredential.findMany({
    where: { owner: { orgId: user.orgId }, OR: [{ ownerId: user.id }, { shareable: true }] },
    include: { owner: true },
    orderBy: [{ createdAt: 'desc' }],
  });
  return creds.map((c) => view(c, user.id));
}

export async function saveCredential(
  userId: string,
  input: { label?: string; token: string; shareable?: boolean },
): Promise<CredentialView> {
  const token = (input.token || '').trim();
  if (!token) throw new Error('A Claude token is required');
  const created = await prisma.claudeCredential.create({
    data: {
      ownerId: userId,
      label: (input.label || '').trim() || 'My Claude',
      token: encrypt(token),
      shareable: !!input.shareable,
    },
    include: { owner: true },
  });
  return view(created, userId);
}

export async function setShareable(id: string, userId: string, shareable: boolean): Promise<boolean> {
  const res = await prisma.claudeCredential.updateMany({ where: { id, ownerId: userId }, data: { shareable } });
  return res.count > 0;
}

export async function deleteCredential(id: string, userId: string): Promise<boolean> {
  const res = await prisma.claudeCredential.deleteMany({ where: { id, ownerId: userId } });
  return res.count > 0;
}

/** Assign (or clear) the credential a project's agent runs use. Caller authorizes. */
export async function setProjectCredential(projectId: string, credentialId: string | null): Promise<void> {
  await prisma.project.update({ where: { id: projectId }, data: { claudeCredentialId: credentialId } });
}

/**
 * Decrypted token for a project's agent runs, or null to fall back to the env token.
 *
 * Resolution order per RUN:
 *   1. the project's assigned credential — if the requester may use it
 *   2. the requester's own credential — everyone runs on their own subscription
 *      by default, no project setup needed
 *   3. null → the platform env token
 *
 * PRIVACY: a PRIVATE (non-shareable) credential is only used for runs triggered
 * by its OWNER — another user must never silently consume a teammate's personal
 * Claude subscription. `requesterUserId` is unknown (undefined) only when the
 * auth gate is off, where per-user attribution doesn't exist anyway.
 */
export async function resolveProjectClaudeToken(
  projectId: string,
  requesterUserId?: string,
): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { claudeCredentialId: true },
  });

  // 1) The project's assigned credential — when the requester may use it
  //    (shareable, their own, or requester unknown = auth off).
  if (project?.claudeCredentialId) {
    const cred = await prisma.claudeCredential.findUnique({ where: { id: project.claudeCredentialId } });
    if (cred) {
      if (!cred.shareable && requesterUserId && cred.ownerId !== requesterUserId) {
        console.log(
          `[ClaudeCredentials] Project ${projectId} is assigned a PRIVATE credential (owner ${cred.ownerId}); ` +
          `requester ${requesterUserId} is not the owner — trying their own credential instead.`,
        );
      } else {
        const token = decryptAndStamp(cred);
        if (token) return token;
      }
    }
  }

  // 2) The requester's OWN credential (most recently connected) — every user's
  //    runs default to their own subscription without any project setup.
  if (requesterUserId) {
    const own = await prisma.claudeCredential.findFirst({
      where: { ownerId: requesterUserId },
      orderBy: { createdAt: 'desc' },
    });
    if (own) {
      const token = decryptAndStamp(own);
      if (token) return token;
    }
  }

  // 3) Neither → the platform env token (caller falls back).
  return null;
}

/**
 * Whether THIS run's resolved Claude token belongs to the acting user's OWN
 * account — mirrors resolveProjectClaudeToken's resolution order. Used to gate
 * account-connector passthrough: the agent may inherit the account's managed
 * connectors (Gmail/Drive/…) only when the token is the acting user's own, so a
 * teammate running a project on a SHARED or the GLOBAL token never wields
 * someone else's connected accounts.
 *
 * Returns true when: auth is off (single operator); the requester's own
 * credential is used; the assigned credential is owned by the requester; or the
 * run falls back to the global env token AND `CLAUDE_GLOBAL_TOKEN_OWNER`
 * (a userId or email) identifies the requester as that token's owner.
 */
export async function runUsesRequestersOwnAccount(
  projectId: string,
  requesterUserId?: string,
): Promise<boolean> {
  // Auth off → no multi-user; the one operator's account is their own.
  if (!requesterUserId) return true;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { claudeCredentialId: true },
  });

  if (project?.claudeCredentialId) {
    const cred = await prisma.claudeCredential.findUnique({
      where: { id: project.claudeCredentialId },
      select: { ownerId: true, shareable: true },
    });
    if (cred) {
      // The assigned credential is USED for this run when it's shareable or the
      // requester owns it (matches resolveProjectClaudeToken step 1). If used, it
      // is the requester's OWN account only when they own it.
      if (cred.shareable || cred.ownerId === requesterUserId) {
        return cred.ownerId === requesterUserId;
      }
      // Private + not owner → not used; falls through to the requester's own.
    }
  }

  // Step 2: the requester's own credential is used → their own account.
  const own = await prisma.claudeCredential.findFirst({
    where: { ownerId: requesterUserId },
    select: { id: true },
  });
  if (own) return true;

  // Step 3: the global env token. Owned by no user unless declared. Only "own"
  // when CLAUDE_GLOBAL_TOKEN_OWNER names this requester (by id or email).
  const globalOwner = (process.env.CLAUDE_GLOBAL_TOKEN_OWNER || '').trim().toLowerCase();
  if (globalOwner) {
    if (globalOwner === requesterUserId.toLowerCase()) return true;
    const u = await prisma.user.findUnique({ where: { id: requesterUserId }, select: { email: true } });
    if (u && globalOwner === u.email.toLowerCase()) return true;
  }
  return false;
}

function decryptAndStamp(cred: ClaudeCredential): string | null {
  try {
    const token = decrypt(cred.token);
    if (!token) return null;
    prisma.claudeCredential
      .update({ where: { id: cred.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
    return token;
  } catch {
    return null;
  }
}
