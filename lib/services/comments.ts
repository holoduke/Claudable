/**
 * Preview review-comments — pinned annotations on the previewed site, scoped per
 * route, stored ONLY in Claudable (never in the app source). Each comment snapshots
 * its author's name at create time and joins the live author for the avatar.
 */
import { prisma } from '@/lib/db/client';
import type { Comment, User } from '@prisma/client';

type CommentWithAuthor = Comment & { author: Pick<User, 'id' | 'name' | 'email' | 'image'> | null };

export function serializeComment(c: CommentWithAuthor) {
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
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
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
}) {
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
