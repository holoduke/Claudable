// Is node_modules actually complete? The preview used to install only when
// node_modules was missing or empty, so a dependency added to package.json while
// node_modules already existed (an agent edit whose install didn't finish, a git
// sync, a partial install) was never installed: the app then failed on the
// missing package — or silently took a fallback path — on every start.
import fs from 'fs/promises';
import path from 'path';
import { readFileInside } from '@/lib/utils/safe-fs';

const MAX_DEPS = 2000;
// Specs that don't produce a node_modules/<name> entry we can check reliably.
const UNCHECKABLE_SPEC = /^(workspace:|catalog:)/u;
const NAME_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/iu;

/**
 * Names in dependencies/devDependencies without a node_modules/<name> entry.
 * Empty when node_modules doesn't exist (the normal first install handles that)
 * or when package.json can't be read.
 */
export async function missingDependencies(projectPath: string): Promise<string[]> {
  const nodeModules = path.join(projectPath, 'node_modules');
  if (!(await fs.stat(nodeModules).then((s) => s.isDirectory(), () => false))) return [];
  const raw = await readFileInside(projectPath, path.join(projectPath, 'package.json'));
  if (!raw) return [];
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw.toString('utf8'));
  } catch {
    return [];
  }
  const wanted: string[] = [];
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (!NAME_RE.test(name) || (typeof spec === 'string' && UNCHECKABLE_SPEC.test(spec))) continue;
      wanted.push(name);
    }
  }
  const missing: string[] = [];
  for (const name of wanted.slice(0, MAX_DEPS)) {
    // lstat: a `file:`/`link:` dependency is a symlink — present is present.
    const present = await fs.lstat(path.join(nodeModules, name)).then(() => true, () => false);
    if (!present) missing.push(name);
  }
  return missing;
}

/**
 * npm's hidden lockfile (node_modules/.package-lock.json) can claim packages the
 * folder doesn't hold; npm may then trust it and skip them again. Remove it
 * before a repair install so npm re-reads the real tree.
 */
export async function dropHiddenLockfile(projectPath: string): Promise<void> {
  const hidden = path.join(projectPath, 'node_modules', '.package-lock.json');
  const stat = await fs.lstat(hidden).catch(() => null);
  if (stat?.isFile()) await fs.unlink(hidden).catch(() => {});
}
