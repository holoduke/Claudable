/**
 * Symlink-safe file access for project directories.
 *
 * Project trees are written by the agent and by the previewed app, so any path
 * inside them may be a symlink pointing at the control plane (/proc/self/environ,
 * the database, Claudable's own code). Everything the Claudable process reads from
 * or writes into a project therefore goes through these helpers: the REAL path
 * (all symlinks resolved) must stay inside the project's real root, and writes
 * never follow a symlink in the final component.
 */
import fsSync, { constants as fsConstants } from 'fs';
import fs from 'fs/promises';
import path from 'path';

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** The real path of `target` when it exists and stays inside `root`, else null. */
export async function realPathInside(root: string, target: string): Promise<string | null> {
  try {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    return isInside(realRoot, realTarget) ? realTarget : null;
  } catch {
    return null;
  }
}

/** Read a regular file inside `root`; null when missing, not a file, or escaping via a symlink. */
export async function readFileInside(root: string, target: string): Promise<Buffer | null> {
  const real = await realPathInside(root, target);
  if (!real) return null;
  const stat = await fs.stat(real).catch(() => null);
  if (!stat?.isFile()) return null;
  return fs.readFile(real);
}

/**
 * Write `data` to `target` inside `root`. The parent directory is created if
 * needed and must resolve inside `root`; an existing symlink at `target` is
 * refused (O_NOFOLLOW) rather than followed.
 */
export async function writeFileInside(root: string, target: string, data: Uint8Array | string): Promise<void> {
  const parent = path.dirname(path.resolve(target));
  await fs.mkdir(parent, { recursive: true });
  const realParent = await realPathInside(root, parent);
  if (!realParent) throw new Error('Refusing to write outside the project directory');
  const destination = path.join(realParent, path.basename(target));
  const handle = await fs.open(
    destination,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/** Create `dir` (recursively) and require that it resolves inside `root`; returns its real path. */
export async function ensureDirInside(root: string, dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const real = await realPathInside(root, dir);
  if (!real) throw new Error('Refusing to use a directory outside the project');
  return real;
}

/**
 * Text content of a file inside `root`: '' when it does not exist, an error when
 * it exists but resolves outside the project (a planted symlink).
 */
export async function readTextInside(root: string, target: string): Promise<string> {
  try {
    await fs.lstat(target);
  } catch {
    return '';
  }
  const data = await readFileInside(root, target);
  if (data === null) throw new Error('Refusing to read a file outside the project');
  return data.toString('utf8');
}

// ---- synchronous variants (for code paths that are synchronous, e.g. git.ts) ----

function realPathInsideSync(root: string, target: string): string | null {
  try {
    const realRoot = fsSync.realpathSync(root);
    const realTarget = fsSync.realpathSync(target);
    return isInside(realRoot, realTarget) ? realTarget : null;
  } catch {
    return null;
  }
}

export function readTextInsideSync(root: string, target: string): string {
  try {
    fsSync.lstatSync(target);
  } catch {
    return '';
  }
  const real = realPathInsideSync(root, target);
  if (!real || !fsSync.statSync(real).isFile()) throw new Error('Refusing to read a file outside the project');
  return fsSync.readFileSync(real, 'utf8');
}

export function writeFileInsideSync(root: string, target: string, data: string): void {
  const parent = path.dirname(path.resolve(target));
  fsSync.mkdirSync(parent, { recursive: true });
  const realParent = realPathInsideSync(root, parent);
  if (!realParent) throw new Error('Refusing to write outside the project directory');
  const fd = fsSync.openSync(
    path.join(realParent, path.basename(target)),
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    fsSync.writeFileSync(fd, data);
  } finally {
    fsSync.closeSync(fd);
  }
}
