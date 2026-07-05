// Project bootstrap helpers: package-manager detection, dependency install, root-structure normalization.
import path from 'path';
import fs from 'fs/promises';
import { appendCommandLogs } from './process-utils';

export const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const yarnCommand = process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
const bunCommand = process.platform === 'win32' ? 'bun.exe' : 'bun';

type PackageManagerId = 'npm' | 'pnpm' | 'yarn' | 'bun';

const PACKAGE_MANAGER_COMMANDS: Record<
  PackageManagerId,
  { command: string; installArgs: string[] }
> = {
  npm: { command: npmCommand, installArgs: ['install'] },
  pnpm: { command: pnpmCommand, installArgs: ['install'] },
  yarn: { command: yarnCommand, installArgs: ['install'] },
  bun: { command: bunCommand, installArgs: ['install'] },
};

const ROOT_ALLOWED_FILES = new Set([
  '.DS_Store',
  '.editorconfig',
  '.env',
  '.env.development',
  '.env.local',
  '.env.production',
  '.eslintignore',
  '.eslintrc',
  '.eslintrc.cjs',
  '.eslintrc.js',
  '.eslintrc.json',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc',
  '.prettierrc.cjs',
  '.prettierrc.js',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'LICENSE',
  'README',
  'README.md',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'requirements.txt',
  'yarn.lock',
]);
const ROOT_ALLOWED_DIR_PREFIXES = ['.'];
const ROOT_ALLOWED_DIRS = new Set([
  '.git',
  '.idea',
  '.vscode',
  '.github',
  '.husky',
  '.pnpm-store',
  '.turbo',
  '.next',
  'node_modules',
]);
const ROOT_OVERWRITABLE_FILES = new Set([
  '.gitignore',
  '.eslintignore',
  '.env',
  '.env.development',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  'README',
  'README.md',
  'README.txt',
]);

export async function readPackageJson(
  projectPath: string
): Promise<Record<string, any> | null> {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function fileExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function parsePackageManagerField(value: unknown): PackageManagerId | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const [rawName] = value.split('@');
  const name = rawName.trim().toLowerCase();
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    return name as PackageManagerId;
  }
  return null;
}

function isCommandNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as NodeJS.ErrnoException;
  return err.code === 'ENOENT';
}

async function detectPackageManager(projectPath: string): Promise<PackageManagerId> {
  const packageJson = await readPackageJson(projectPath);
  const fromField = parsePackageManagerField(packageJson?.packageManager);
  if (fromField) {
    return fromField;
  }

  if (await fileExists(path.join(projectPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (await fileExists(path.join(projectPath, 'yarn.lock'))) {
    return 'yarn';
  }
  if (await fileExists(path.join(projectPath, 'bun.lockb'))) {
    return 'bun';
  }
  if (await fileExists(path.join(projectPath, 'package-lock.json'))) {
    return 'npm';
  }
  return 'npm';
}

export async function runInstallWithPreferredManager(
  projectPath: string,
  env: NodeJS.ProcessEnv,
  logger: (chunk: Buffer | string) => void
): Promise<void> {
  const manager = await detectPackageManager(projectPath);
  const { command, installArgs } = PACKAGE_MANAGER_COMMANDS[manager];

  logger(`[PreviewManager] Installing dependencies using ${manager}.`);
  try {
    await appendCommandLogs(command, installArgs, projectPath, env, logger);
  } catch (error) {
    if (manager !== 'npm' && isCommandNotFound(error)) {
      logger(
        `[PreviewManager] ${command} unavailable. Falling back to npm install.`
      );
      await appendCommandLogs(
        PACKAGE_MANAGER_COMMANDS.npm.command,
        PACKAGE_MANAGER_COMMANDS.npm.installArgs,
        projectPath,
        env,
        logger
      );
      return;
    }
    throw error;
  }
}

async function isLikelyNextProject(dirPath: string): Promise<boolean> {
  const pkgPath = path.join(dirPath, 'package.json');
  try {
    const pkgRaw = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgRaw);
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    if (typeof deps.next === 'string') {
      return true;
    }
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      const scriptValues = Object.values(pkg.scripts as Record<string, unknown>);
      if (
        scriptValues.some(
          (value) =>
            typeof value === 'string' &&
            (value.includes('next dev') || value.includes('next start'))
        )
      ) {
        return true;
      }
    }
  } catch {
    // ignore
  }

  const configCandidates = [
    'next.config.js',
    'next.config.cjs',
    'next.config.mjs',
    'next.config.ts',
  ];
  for (const candidate of configCandidates) {
    if (await fileExists(path.join(dirPath, candidate))) {
      return true;
    }
  }

  const appDirCandidates = [
    'app',
    path.join('src', 'app'),
    'pages',
    path.join('src', 'pages'),
  ];
  for (const candidate of appDirCandidates) {
    if (await directoryExists(path.join(dirPath, candidate))) {
      return true;
    }
  }

  return false;
}

function isAllowedRootFile(name: string): boolean {
  if (ROOT_ALLOWED_FILES.has(name)) {
    return true;
  }
  if (name.endsWith('.md') || name.startsWith('.env.')) {
    return true;
  }
  return false;
}

function isAllowedRootDirectory(name: string): boolean {
  if (ROOT_ALLOWED_DIRS.has(name)) {
    return true;
  }
  return ROOT_ALLOWED_DIR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isOverwritableRootFile(name: string): boolean {
  if (ROOT_OVERWRITABLE_FILES.has(name)) {
    return true;
  }
  if (name.startsWith('.env.') || name.endsWith('.md')) {
    return true;
  }
  return false;
}

export async function ensureProjectRootStructure(
  projectPath: string,
  log: (message: string) => void
): Promise<void> {
  const entries = await fs.readdir(projectPath, { withFileTypes: true });
  // If the project explicitly defines how to run itself via .claudable/preview.json,
  // its layout is intentional (e.g. a monorepo with frontend + backend subdirs) —
  // do NOT try to auto-restructure it into a single root app.
  if (await pathExists(path.join(projectPath, '.claudable', 'preview.json'))) {
    return;
  }
  const hasRootPackageJson = entries.some(
    (entry) => entry.isFile() && entry.name === 'package.json'
  );
  if (hasRootPackageJson) {
    return;
  }

  const candidateDirs: { name: string; path: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === 'node_modules') {
      continue;
    }
    const dirPath = path.join(projectPath, entry.name);
    // quick skip for empty directory
    const isCandidate = await isLikelyNextProject(dirPath);
    if (isCandidate) {
      candidateDirs.push({ name: entry.name, path: dirPath });
    }
  }

  if (candidateDirs.length === 0) {
    return;
  }

  if (candidateDirs.length > 1) {
    const dirNames = candidateDirs.map((dir) => dir.name).join(', ');
    throw new Error(
      `Multiple potential Next.js projects detected in subdirectories (${dirNames}). Please move the desired project files to the project root.`
    );
  }

  const candidate = candidateDirs[0];
  const { name: nestedName, path: nestedPath } = candidate;

  for (const entry of entries) {
    if (entry.name === nestedName) {
      continue;
    }
    if (entry.isDirectory()) {
      if (!isAllowedRootDirectory(entry.name)) {
        throw new Error(
          `Cannot normalize project structure because directory "${entry.name}" exists alongside "${nestedName}". Move project files to the root manually.`
        );
      }
      continue;
    }

    if (!isAllowedRootFile(entry.name)) {
      throw new Error(
        `Cannot normalize project structure because file "${entry.name}" exists alongside "${nestedName}". Move project files to the root manually.`
      );
    }
  }

  // Remove nested node_modules and root node_modules (if any) to avoid conflicts during move.
  await fs.rm(path.join(nestedPath, 'node_modules'), { recursive: true, force: true });
  await fs.rm(path.join(projectPath, 'node_modules'), { recursive: true, force: true });

  const nestedEntries = await fs.readdir(nestedPath, { withFileTypes: true });
  for (const nestedEntry of nestedEntries) {
    const sourcePath = path.join(nestedPath, nestedEntry.name);
    const destinationPath = path.join(projectPath, nestedEntry.name);
    if (await pathExists(destinationPath)) {
      if (nestedEntry.isFile() && isOverwritableRootFile(nestedEntry.name)) {
        await fs.rm(destinationPath, { force: true });
        await fs.rename(sourcePath, destinationPath);
        log(
          `Replaced existing root file "${nestedEntry.name}" with the version from "${nestedName}".`
        );
        continue;
      }
      throw new Error(
        `Cannot move "${nestedEntry.name}" from "${nestedName}" because "${nestedEntry.name}" already exists in the project root.`
      );
    }
    await fs.rename(sourcePath, destinationPath);
  }

  await fs.rm(nestedPath, { recursive: true, force: true });
  log(
    `Detected Next.js project inside subdirectory "${nestedName}". Contents moved to the project root.`
  );
}
