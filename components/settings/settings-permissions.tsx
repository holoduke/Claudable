"use client";
/**
 * Client side of the project permissions contract (see
 * lib/services/settings-permissions.ts): GET /api/projects/:id returns
 * `permissions` for the signed-in user. Settings tabs use it to hide or explain
 * controls that the server would refuse with a 403.
 */
import { useEffect, useState } from 'react';
import { FaLock } from 'react-icons/fa';
import { useT } from '@/contexts/I18nContext';
import type { ProjectPermissions } from '@/lib/services/settings-permissions';

export type { ProjectPermissions };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

/** Optimistic default while loading / when the project has no permissions block (auth off). */
export const DEFAULT_PERMISSIONS: ProjectPermissions = Object.freeze({
  canWrite: true,
  canManage: true,
  canConfigure: true,
  fullEdit: true,
});

/** What a settings control needs, mirroring the API gate options. */
export type PermissionNeed = 'write' | 'manage' | 'configure' | 'configureFull';

export type DenyReason = 'readOnly' | 'managedByNewStory' | 'ownerOnly' | 'editProfile';

/** Why `need` is not met (null = allowed). Order matches lib/auth/gate.ts. */
export function denyReason(p: ProjectPermissions, need: PermissionNeed): DenyReason | null {
  if (!p.canWrite && need !== 'manage') return 'readOnly';
  if (need === 'manage' && !p.canManage) {
    // A writer who cannot even configure is a customer in a customer project.
    return p.canWrite && !p.canConfigure ? 'managedByNewStory' : 'ownerOnly';
  }
  if ((need === 'configure' || need === 'configureFull') && !p.canConfigure) return 'managedByNewStory';
  if (need === 'configureFull' && !p.fullEdit) return 'editProfile';
  return null;
}

export function useProjectPermissions(projectId: string, enabled: boolean): { permissions: ProjectPermissions; loaded: boolean } {
  const [state, setState] = useState<{ id: string; permissions: ProjectPermissions } | null>(null);
  useEffect(() => {
    if (!enabled || !projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}`);
        const json = res.ok ? await res.json() : null;
        const p = json?.data?.permissions as ProjectPermissions | undefined;
        if (!cancelled) setState({ id: projectId, permissions: p ?? DEFAULT_PERMISSIONS });
      } catch {
        // Network trouble: stay optimistic — the server still enforces every gate.
        if (!cancelled) setState({ id: projectId, permissions: DEFAULT_PERMISSIONS });
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, enabled]);
  const loaded = state?.id === projectId;
  return { permissions: loaded ? state.permissions : DEFAULT_PERMISSIONS, loaded };
}

/** One-line explanation shown instead of (or above) a control the user may not use. */
export function PermissionNotice({ reason, className = '' }: { reason: DenyReason; className?: string }) {
  const t = useT();
  return (
    <p
      role="note"
      className={`flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 ${className}`}
    >
      <span className="mt-0.5 shrink-0" aria-hidden><FaLock /></span>
      <span>{t(`settings.perm.${reason}` as const)}</span>
    </p>
  );
}
