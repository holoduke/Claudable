/**
 * Provision the database a project was COMPOSED with at creation time
 * (settings.databaseType, picked on the start screen).
 *
 *  - sqlite:   nothing to provision (a file in the repo).
 *  - postgres: a per-project container DB (template 'postgres') when managed
 *              containers are available, else the legacy Coolify host DB.
 *  - mysql:    a per-project container DB (template 'mysql' — official image,
 *              named volume, healthcheck, DATABASE_URL injected). There is NO
 *              host/Coolify fallback for MySQL, so it is only offered when
 *              managed containers are enabled (see databaseAvailable).
 */
import type { DatabaseKind } from '@/lib/config/databases';

export type DatabaseProvisionMode = 'container' | 'coolify' | 'none';

/** Whether this server can actually provision the given database kind. */
export async function databaseAvailable(kind: DatabaseKind): Promise<boolean> {
  if (kind !== 'mysql') return true;
  const { managedContainersEnabled } = await import('@/lib/services/managed-containers');
  return managedContainersEnabled();
}

/**
 * Provision the chosen database for a freshly created project. Throws on a
 * provisioning failure — callers decide whether that fails the request.
 */
export async function provisionProjectDatabase(projectId: string, kind: DatabaseKind): Promise<DatabaseProvisionMode> {
  if (kind === 'sqlite') return 'none';
  const { managedContainersEnabled, addServiceFromTemplate } = await import('@/lib/services/managed-containers');
  if (managedContainersEnabled()) {
    await addServiceFromTemplate(projectId, kind);
    return 'container';
  }
  if (kind === 'postgres') {
    const { provisionPostgres } = await import('@/lib/services/database');
    await provisionPostgres(projectId);
    return 'coolify';
  }
  throw new Error(`${kind} needs managed containers (PREVIEW_ISOLATION) on this server`);
}
