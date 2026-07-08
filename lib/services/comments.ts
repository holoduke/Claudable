/**
 * Preview review-comments — pinned annotations on the previewed site, scoped per
 * route, stored ONLY in Claudable (never in the app source). Each comment snapshots
 * its author's name at create time and joins the live author for the avatar.
 */
import { prisma } from '@/lib/db/client';
import type { Comment, User } from '@prisma/client';
import { parseMentionsJson, sanitizeMentions, type CommentMention } from '@/lib/utils/mentions';

type CommentWithAuthor = Comment & { author: Pick<User, 'id' | 'name' | 'email' | 'image'> | null };

function serializeComment(c: CommentWithAuthor) {
  const name = c.authorName || c.author?.name || (c.author?.email ? c.author.email.split('@')[0] : null) || 'Anonymous';
  return {
    id: c.id,
    route: c.route,
    anchorSelector: c.anchorSelector,
    relX: c.relX,
    relY: c.relY,
    body: c.body,
    resolved: c.resolved,
    authorName: name,
    authorImage: c.author?.image ?? null,
    mentions: parseMentionsJson(c.mentionsJson),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/**
 * Keep only mentions that point at real, active users in the author's org —
 * the client payload is untrusted, and cross-org user ids must never be
 * echoed back to other viewers. Names are re-snapshotted from the DB so a
 * spoofed payload can't attach an arbitrary label to a real user id.
 */
async function resolveMentions(raw: unknown, authorOrgId: string | undefined): Promise<CommentMention[]> {
  const candidates = sanitizeMentions(raw);
  if (!candidates.length || !authorOrgId) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: candidates.map((m) => m.id) }, orgId: authorOrgId, isActive: true },
    select: { id: true, name: true, email: true },
  });
  return users.map((u) => ({ id: u.id, name: u.name || u.email.split('@')[0] }));
}

export async function listComments(projectId: string, route?: string) {
  const rows = await prisma.comment.findMany({
    where: { projectId, ...(route ? { route } : {}) },
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { id: true, name: true, email: true, image: true } } },
  });
  return rows.map(serializeComment);
}

export async function createComment(input: {
  projectId: string;
  route: string;
  anchorSelector: string;
  relX: number;
  relY: number;
  body: string;
  authorId?: string | null;
  authorName?: string | null;
  /** Untrusted @-mention payload; validated against the author's org. */
  mentions?: unknown;
  authorOrgId?: string;
}) {
  const mentions = await resolveMentions(input.mentions, input.authorOrgId);
  const created = await prisma.comment.create({
    data: {
      projectId: input.projectId,
      route: input.route,
      anchorSelector: input.anchorSelector,
      relX: input.relX,
      relY: input.relY,
      body: input.body,
      authorId: input.authorId ?? null,
      authorName: input.authorName ?? null,
      mentionsJson: mentions.length ? JSON.stringify(mentions) : null,
    },
    include: { author: { select: { id: true, name: true, email: true, image: true } } },
  });
  return serializeComment(created);
}

export async function updateComment(
  projectId: string,
  id: string,
  patch: { body?: string; resolved?: boolean },
) {
  // Scope by projectId so a comment id from another project can't be touched.
  const existing = await prisma.comment.findFirst({ where: { id, projectId } });
  if (!existing) return null;
  const updated = await prisma.comment.update({
    where: { id },
    data: {
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.resolved !== undefined ? { resolved: patch.resolved } : {}),
    },
    include: { author: { select: { id: true, name: true, email: true, image: true } } },
  });
  return serializeComment(updated);
}

export async function deleteComment(projectId: string, id: string): Promise<boolean> {
  const { count } = await prisma.comment.deleteMany({ where: { id, projectId } });
  return count > 0;
}

/** Clear ALL comments in a project (every route). */
export async function clearComments(projectId: string): Promise<number> {
  const { count } = await prisma.comment.deleteMany({ where: { projectId } });
  return count;
}
