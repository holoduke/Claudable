/**
 * Audit trail for administrative actions (Prisma — Node only).
 *
 * Every write is best-effort: a failed audit insert is logged and swallowed so
 * it can never block or roll back the action it describes. Readers are org
 * managers (own org) and superadmins (any org).
 */
import { prisma } from '@/lib/db/client';

export type AuditAction =
  | 'org.created'
  | 'org.updated'
  | 'org.deleted'
  | 'org.member.added'
  | 'org.member.role_changed'
  | 'org.member.removed'
  | 'org.invite.created'
  | 'org.invite.revoked'
  | 'org.invite.accepted'
  | 'project.visibility_changed'
  | 'project.member.added'
  | 'project.member.role_changed'
  | 'project.member.removed';

export interface AuditActor {
  id?: string | null;
  email?: string | null;
}

export interface AuditInput {
  orgId?: string | null;
  actor?: AuditActor | null;
  action: AuditAction;
  targetType?: 'user' | 'invite' | 'org' | 'project';
  targetId?: string | null;
  meta?: Record<string, unknown>;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        orgId: input.orgId ?? null,
        actorId: input.actor?.id ?? null,
        actorEmail: input.actor?.email ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        meta: input.meta ? JSON.stringify(input.meta) : null,
      },
    });
  } catch (error) {
    console.error('[audit] failed to record', input.action, error);
  }
}

export async function listOrgAudit(orgId: string, limit = 100) {
  const rows = await prisma.auditEvent.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 500),
  });
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    actorEmail: r.actorEmail,
    targetType: r.targetType,
    targetId: r.targetId,
    meta: r.meta ? safeParse(r.meta) : null,
    at: r.createdAt,
  }));
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
