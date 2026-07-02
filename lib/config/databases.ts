/**
 * Optional DATABASE a project can be composed with. Stored on the project's
 * `settings.databaseType`.
 *   - sqlite:   a file in the project — zero infra, works inside the sandbox.
 *   - postgres: provisioned via Coolify (existing one-click), DATABASE_URL injected.
 *   - mysql:    provisioned via Coolify (mirrors postgres).
 */
export type DatabaseKind = 'sqlite' | 'postgres' | 'mysql';

export interface DatabaseOption {
  id: DatabaseKind;
  name: string;
  description: string;
  /** Provisioned through Coolify (needs COOLIFY_* config), vs local to the project. */
  managed: boolean;
}

export const DATABASES: DatabaseOption[] = [
  { id: 'sqlite', name: 'SQLite', description: 'A file-based database in the project — zero infra, great for prototypes.', managed: false },
  { id: 'postgres', name: 'PostgreSQL', description: 'A managed Postgres provisioned via Coolify; DATABASE_URL is injected.', managed: true },
  { id: 'mysql', name: 'MySQL', description: 'A managed MySQL provisioned via Coolify.', managed: true },
];

export function isValidDatabase(id: string | null | undefined): id is DatabaseKind {
  return !!id && DATABASES.some((d) => d.id === id);
}
export function getDatabaseOption(id: string | null | undefined): DatabaseOption | undefined {
  return DATABASES.find((d) => d.id === id);
}
