/**
 * Optional DATABASE a project can be composed with. Stored on the project's
 * `settings.databaseType`.
 *   - sqlite:   a file in the project — zero infra, works inside the sandbox.
 *   - postgres: a per-project container DB (Coolify host DB as legacy fallback),
 *               DATABASE_URL injected.
 *   - mysql:    a per-project container DB (container template 'mysql'); only
 *               available when managed containers are enabled — there is no
 *               host fallback, so project creation refuses it otherwise.
 * Provisioning: lib/services/project-database-provision.ts.
 */
export type DatabaseKind = 'sqlite' | 'postgres' | 'mysql';

export interface DatabaseOption {
  id: DatabaseKind;
  name: string;
  description: string;
  /** Provisioned as a service (container / Coolify), vs a file local to the project. */
  managed: boolean;
}

export const DATABASES: DatabaseOption[] = [
  { id: 'sqlite', name: 'SQLite', description: 'A file-based database in the project — zero infra, great for prototypes.', managed: false },
  { id: 'postgres', name: 'PostgreSQL', description: 'A dedicated Postgres for this project; DATABASE_URL is injected.', managed: true },
  { id: 'mysql', name: 'MySQL', description: 'A dedicated MySQL 8.4 for this project; DATABASE_URL is injected. Needs managed containers on the server.', managed: true },
];

export function isValidDatabase(id: string | null | undefined): id is DatabaseKind {
  return !!id && DATABASES.some((d) => d.id === id);
}
export function getDatabaseOption(id: string | null | undefined): DatabaseOption | undefined {
  return DATABASES.find((d) => d.id === id);
}
