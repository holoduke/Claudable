/**
 * "SQLite" as a project database: a file in the project's own `.data/` folder.
 *
 * Choosing SQLite at project creation (settings.databaseType = 'sqlite') used to
 * store only the choice — no DATABASE_URL, no location — so nothing used it.
 * Every place that runs project code now gets the SAME file, each through the
 * path its container sees (absolute: Prisma resolves a relative `file:` against
 * its schema folder, not the working directory):
 *   preview container  /app/.data/app.db     (project mounted at /app)
 *   agent container    /work/.data/app.db    (project mounted at /work)
 *   backend container  /data/app.db          (.data mounted at /data)
 * `.data/` is git-ignored: the database is runtime state, not source.
 */
import path from 'path';
import { getProjectById } from '@/lib/services/project';
import { getProjectService } from '@/lib/services/project-services';
import { ensureDirInside, readTextInside, writeFileInside } from '@/lib/utils/safe-fs';

export const SQLITE_DIR = '.data';
export const SQLITE_FILE = 'app.db';

/** Env for a process that sees the database file at `absFile`. */
export function sqliteEnv(absFile: string): Record<string, string> {
  return { DATABASE_URL: `file:${absFile}`, DATABASE_PATH: absFile, SQLITE_PATH: absFile };
}

/** True when the project chose SQLite and has no server database attached. */
export async function projectUsesSqlite(projectId: string): Promise<boolean> {
  const project = await getProjectById(projectId).catch(() => null);
  if (!project?.settings) return false;
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(project.settings);
  } catch {
    return false;
  }
  if (settings.databaseType !== 'sqlite') return false;
  const coolify = await getProjectService(projectId, 'database').catch(() => null);
  return !coolify;
}

/** Create `.data/` inside the project (symlink-safe) and git-ignore it. Returns its path. */
export async function ensureSqliteDir(projectPath: string): Promise<string> {
  const dir = await ensureDirInside(projectPath, path.join(projectPath, SQLITE_DIR));
  const giPath = path.join(projectPath, '.gitignore');
  const gi = await readTextInside(projectPath, giPath).catch(() => '');
  const lines = gi.split(/\r?\n/u).map((l) => l.trim());
  if (!lines.includes(`${SQLITE_DIR}/`) && !lines.includes(SQLITE_DIR) && !lines.includes(`/${SQLITE_DIR}`)) {
    const sep = gi.length === 0 || gi.endsWith('\n') ? '' : '\n';
    await writeFileInside(projectPath, giPath, `${gi}${sep}${SQLITE_DIR}/\n`);
  }
  return dir;
}

/** The agent's system-prompt note for the project's database, or '' when it has none. */
export function databasePromptNote(kind: 'postgres' | 'sqlite' | null): string {
  if (kind === 'postgres') {
    return `\n\n## Database\nThis project has a PostgreSQL database. Its connection string is in the DATABASE_URL environment variable (already set in the running preview). Use it for any data persistence — prefer Prisma (schema datasource \`url = env("DATABASE_URL")\`, run \`prisma db push\`) or Drizzle/pg. Never hardcode credentials; always read DATABASE_URL from the environment.`;
  }
  if (kind === 'sqlite') {
    return `\n\n## Database\nThis project uses SQLite: a single database file in the project's \`${SQLITE_DIR}/\` folder (git-ignored — it is runtime data, not source). DATABASE_URL (\`file:<absolute path>\`) and DATABASE_PATH are set in the preview, in any backend container and in your own environment, each pointing at that same file. Always read them from the environment (never hardcode a path): e.g. Prisma \`provider = "sqlite"\` with \`url = env("DATABASE_URL")\` + \`prisma db push\`, or better-sqlite3 / node:sqlite / Drizzle with DATABASE_PATH.`;
  }
  return '';
}
