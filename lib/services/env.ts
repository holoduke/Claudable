import fs from 'fs/promises';
import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { encrypt, decrypt } from '@/lib/crypto';
import type { EnvVar } from '@prisma/client';
import type { Project } from '@/types/backend';
import { getProjectById } from '@/lib/services/project';
import { mergeEnvView, parseEnvFile, patchEnvContents, type EnvPatch, type EnvVarRecord } from '@/lib/services/env-file';

export type { EnvVarRecord } from '@/lib/services/env-file';

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(/* turbopackIgnore: true */ process.cwd(), PROJECTS_DIR);

interface CreateEnvVarInput {
  key: string;
  value: string;
  scope?: string;
  varType?: string;
  isSecret?: boolean;
  description?: string | null;
}

function resolveRepoRoot(project: Project): string {
  const repoPath = project.repoPath || path.join(PROJECTS_DIR_ABSOLUTE, project.id);
  return path.isAbsolute(repoPath) ? repoPath : path.resolve(/* turbopackIgnore: true */ process.cwd(), repoPath);
}

function envFilePath(project: Project): string {
  const repoRoot = resolveRepoRoot(project);
  return path.join(repoRoot, '.env');
}

async function ensureProject(projectId: string): Promise<Project> {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error('Project not found');
  }
  return project;
}

function mapEnvVar(model: EnvVar): EnvVarRecord {
  return {
    id: model.id,
    key: model.key,
    value: decrypt(model.valueEncrypted),
    scope: model.scope,
    var_type: model.varType,
    is_secret: model.isSecret,
    description: model.description,
  };
}

async function readEnvFile(project: Project): Promise<string> {
  try {
    return await fs.readFile(envFilePath(project), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

// Read-patch-write of .env must not interleave between two requests for the
// same project (single Node server → an in-process chained-promise lock).
const envFileLocks = new Map<string, Promise<unknown>>();

async function withEnvFileLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = envFileLocks.get(projectId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  envFileLocks.set(projectId, run);
  try {
    return await run;
  } finally {
    if (envFileLocks.get(projectId) === run) envFileLocks.delete(projectId);
  }
}

/**
 * Patch the project's .env: only the keys in `patch` change; every other line
 * (keys the agent/import wrote, comments, blank lines) is preserved.
 */
async function patchProjectEnvFile(project: Project, patch: EnvPatch): Promise<void> {
  await withEnvFileLock(project.id, async () => {
    const repoEnvPath = envFilePath(project);
    const current = await readEnvFile(project);
    const next = patchEnvContents(current, patch);
    if (next === current) return;
    await fs.mkdir(path.dirname(repoEnvPath), { recursive: true });
    await fs.writeFile(repoEnvPath, next, 'utf8');
  });
}

async function readFileVars(project: Project): Promise<Record<string, string>> {
  return parseEnvFile(await readEnvFile(project));
}

/**
 * The Settings → Envs view: DB rows plus keys that only exist in the project's
 * .env (source: 'file'), so variables the agent/import wrote are visible and
 * editable instead of silently invisible.
 */
export async function listEnvVarsForSettings(projectId: string): Promise<EnvVarRecord[]> {
  const project = await ensureProject(projectId);
  const [dbRows, fileVars] = await Promise.all([listEnvVars(projectId), readFileVars(project)]);
  return mergeEnvView(dbRows, fileVars);
}

/** DB-stored env vars only (what previews/deploys inject). */
export async function listEnvVars(projectId: string): Promise<EnvVarRecord[]> {
  const records = await prisma.envVar.findMany({
    where: { projectId },
    orderBy: { key: 'asc' },
  });
  const result: EnvVarRecord[] = [];
  for (const record of records) {
    try {
      result.push(mapEnvVar(record));
    } catch (error) {
      console.warn(`[EnvService] Failed to decrypt env var ${record.key}:`, error);
    }
  }
  return result;
}

export async function createEnvVar(
  projectId: string,
  input: CreateEnvVarInput,
): Promise<EnvVarRecord> {
  const project = await ensureProject(projectId);
  try {
    const created = await prisma.envVar.create({
      data: {
        projectId,
        key: input.key,
        valueEncrypted: encrypt(input.value),
        scope: input.scope ?? 'runtime',
        varType: input.varType ?? 'string',
        isSecret: input.isSecret ?? true,
        description: input.description,
      },
    });

    await patchProjectEnvFile(project, { set: { [input.key]: input.value } });
    return mapEnvVar(created);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new Error(`Environment variable "${input.key}" already exists`);
    }
    throw error;
  }
}

export async function updateEnvVar(
  projectId: string,
  key: string,
  value: string,
): Promise<boolean> {
  const project = await ensureProject(projectId);
  const existing = await prisma.envVar.findUnique({
    where: { projectId_key: { projectId, key } },
  });
  if (existing) {
    await prisma.envVar.update({
      where: { projectId_key: { projectId, key } },
      data: { valueEncrypted: encrypt(value) },
    });
  } else {
    // A key that only lives in .env (agent/import wrote it): editing it in
    // Settings adopts it into the DB. Unknown keys stay a 404.
    const fileVars = await readFileVars(project);
    if (!Object.prototype.hasOwnProperty.call(fileVars, key)) return false;
    await prisma.envVar.upsert({
      where: { projectId_key: { projectId, key } },
      update: { valueEncrypted: encrypt(value) },
      create: {
        projectId,
        key,
        valueEncrypted: encrypt(value),
        scope: 'runtime',
        varType: 'string',
        isSecret: true,
        description: 'Imported from .env',
      },
    });
  }

  await patchProjectEnvFile(project, { set: { [key]: value } });
  return true;
}

export async function deleteEnvVar(projectId: string, key: string): Promise<boolean> {
  const project = await ensureProject(projectId);
  const { count } = await prisma.envVar.deleteMany({ where: { projectId, key } });
  const inFile = Object.prototype.hasOwnProperty.call(await readFileVars(project), key);
  if (count === 0 && !inFile) return false;
  if (inFile) await patchProjectEnvFile(project, { remove: [key] });
  return true;
}

/**
 * Write every DB-managed var into the project's .env. Merge, not overwrite:
 * DB values win for DB keys, while keys that exist only in the file (written by
 * the agent or an import), comments and blank lines are preserved.
 */
export async function syncDbToEnvFile(projectId: string): Promise<number> {
  const project = await ensureProject(projectId);

  const envVars = await prisma.envVar.findMany({
    where: { projectId },
    orderBy: { key: 'asc' },
  });

  const set: Record<string, string> = {};
  for (const envVar of envVars) {
    try {
      set[envVar.key] = decrypt(envVar.valueEncrypted);
    } catch (error) {
      console.warn(`[EnvService] Failed to decrypt env var ${envVar.key}:`, error);
    }
  }

  await patchProjectEnvFile(project, { set });
  return Object.keys(set).length;
}

export async function syncEnvFileToDb(projectId: string): Promise<number> {
  const project = await ensureProject(projectId);
  const repoEnvPath = envFilePath(project);

  let fileContents = '';
  try {
    fileContents = await fs.readFile(repoEnvPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }

  const fileVars = parseEnvFile(fileContents);
  const existingVars = await prisma.envVar.findMany({
    where: { projectId },
  });

  const existingMap = new Map(existingVars.map((envVar) => [envVar.key, envVar]));
  const fileKeys = new Set(Object.keys(fileVars));
  let changes = 0;

  for (const [key, value] of Object.entries(fileVars)) {
    const current = existingMap.get(key);
    if (current) {
      let currentValue: string | null = null;
      try {
        currentValue = decrypt(current.valueEncrypted);
      } catch (error) {
        console.warn(`[EnvService] Failed to decrypt env var ${current.key}:`, error);
      }
      if (currentValue !== value) {
        await prisma.envVar.update({
          where: {
            projectId_key: { projectId, key },
          },
          data: { valueEncrypted: encrypt(value) },
        });
        changes += 1;
      }
    } else {
      await prisma.envVar.create({
        data: {
          projectId,
          key,
          valueEncrypted: encrypt(value),
          scope: 'runtime',
          varType: 'string',
          isSecret: true,
        },
      });
      changes += 1;
    }
  }

  for (const envVar of existingVars) {
    if (!fileKeys.has(envVar.key)) {
      await prisma.envVar.delete({
        where: {
          projectId_key: { projectId, key: envVar.key },
        },
      });
      changes += 1;
    }
  }

  return changes;
}

export async function detectEnvConflicts(projectId: string) {
  const project = await ensureProject(projectId);
  const repoEnvPath = envFilePath(project);

  let fileContents = '';
  try {
    fileContents = await fs.readFile(repoEnvPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      fileContents = '';
    } else {
      throw error;
    }
  }

  const fileVars = parseEnvFile(fileContents);
  const dbVars = await listEnvVars(projectId);

  const conflicts: Array<{
    key: string;
    file_value?: string;
    db_value?: string;
    conflict_type: 'file_only' | 'db_only' | 'value_mismatch';
  }> = [];

  const keys = new Set([...Object.keys(fileVars), ...dbVars.map((envVar) => envVar.key)]);

  for (const key of keys) {
    const fileValue = fileVars[key];
    const dbValue = dbVars.find((envVar) => envVar.key === key)?.value;

    if (fileValue === dbValue) {
      continue;
    }

    let conflictType: 'file_only' | 'db_only' | 'value_mismatch';
    if (fileValue !== undefined && dbValue === undefined) {
      conflictType = 'file_only';
    } else if (fileValue === undefined && dbValue !== undefined) {
      conflictType = 'db_only';
    } else {
      conflictType = 'value_mismatch';
    }

    conflicts.push({
      key,
      file_value: fileValue,
      db_value: dbValue,
      conflict_type: conflictType,
    });
  }

  return {
    conflicts,
    has_conflicts: conflicts.length > 0,
  };
}

export async function upsertEnvVar(
  projectId: string,
  input: CreateEnvVarInput,
): Promise<EnvVarRecord> {
  const project = await ensureProject(projectId);
  const updated = await prisma.envVar.upsert({
    where: {
      projectId_key: {
        projectId,
        key: input.key,
      },
    },
    update: {
      valueEncrypted: encrypt(input.value),
      description: input.description,
      scope: input.scope ?? 'runtime',
      varType: input.varType ?? 'string',
      isSecret: input.isSecret ?? true,
    },
    create: {
      projectId,
      key: input.key,
      valueEncrypted: encrypt(input.value),
      description: input.description,
      scope: input.scope ?? 'runtime',
      varType: input.varType ?? 'string',
      isSecret: input.isSecret ?? true,
    },
  });

  await patchProjectEnvFile(project, { set: { [input.key]: input.value } });
  return mapEnvVar(updated);
}
