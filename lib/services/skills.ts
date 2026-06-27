/**
 * Per-project Agent Skills.
 *
 * Skills live in `<project>/.claude/skills/<name>/SKILL.md`. Because the agent
 * runs with cwd = project dir and Claudable enables `settingSources: ['project']`
 * (see cli/claude.ts), every skill here is auto-discovered for that project's agent.
 *
 * A SKILL.md is markdown with YAML frontmatter:
 *   ---
 *   name: my-skill
 *   description: One line shown to the model to decide when to use it.
 *   ---
 *   <instructions body>
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getProjectById } from '@/lib/services/project';

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(process.cwd(), PROJECTS_DIR);

export interface Skill {
  id: string; // on-disk directory name — the stable identifier used for enable/disable
  name: string;
  description: string;
  content: string; // body (without frontmatter)
  raw: string; // full SKILL.md
  scope: 'project' | 'global'; // project = editable; global = read-only (shared)
  enabled: boolean; // active for this project (false = not loaded by the agent)
}

const STATE_FILE = '.skills-state.json'; // <project>/.claude/.skills-state.json
const DISABLED_SUBDIR = '.disabled'; // parked (disabled) project skills

export class SkillError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'SkillError';
  }
}

/** kebab-case slug; rejects path traversal / unsafe names. */
export function normalizeSkillName(name: string): string {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) {
    throw new SkillError('Invalid skill name');
  }
  return slug;
}

async function projectBaseDir(projectId: string): Promise<string> {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new SkillError('Project not found', 404);
  }
  if (project.repoPath) {
    return path.isAbsolute(project.repoPath)
      ? project.repoPath
      : path.resolve(process.cwd(), project.repoPath);
  }
  return path.join(PROJECTS_DIR_ABSOLUTE, projectId);
}

async function skillsDir(projectId: string): Promise<string> {
  return path.join(await projectBaseDir(projectId), '.claude', 'skills');
}

function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { body: raw };
  }
  const [, fm, body] = match;
  const get = (key: string) => {
    const m = fm.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
  };
  return { name: get('name'), description: get('description'), body: body.trimStart() };
}

function buildSkillMarkdown(name: string, description: string, content: string): string {
  const desc = (description || '').replace(/\n/g, ' ').trim();
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${content.trim()}\n`;
}

/** Global skills shared across all projects: ~/.claude/skills (mounted into the container). */
function globalSkillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

async function readSkillsDir(
  dir: string,
  scope: 'project' | 'global',
  opts: { skipSymlinks?: boolean } = {},
): Promise<Skill[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue; // skip .disabled and other dotdirs
    try {
      if (opts.skipSymlinks) {
        // Symlinks in a project's skills dir are staged globals — list those
        // from the global library instead, not as project skills.
        const st = await fs.lstat(path.join(dir, entry));
        if (st.isSymbolicLink()) continue;
      }
      const raw = await fs.readFile(path.join(dir, entry, 'SKILL.md'), 'utf8');
      const { name, description, body } = parseFrontmatter(raw);
      skills.push({ id: entry, name: name || entry, description: description || '', content: body, raw, scope, enabled: true });
    } catch {
      // skip dirs without a readable SKILL.md
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Per-project enable/disable state + enforcement
//
// "Enabled" is the source of truth (a disabled-set stored per project). The
// agent only ever loads skills from `<project>/.claude/skills` (settingSources
// is ['project'] — see cli/claude.ts), so enforcement = staging exactly the
// enabled skills into that dir:
//   - enabled project skills  -> real dirs (left in place)
//   - disabled project skills -> moved into `.claude/skills/.disabled/<id>`
//   - enabled global skills   -> symlinks into `.claude/skills/<id>`
//   - disabled global skills  -> no symlink
// This is a hard guarantee (a disabled skill is simply not present), and it is
// per-project (symlinks/parking live inside the project).
// ---------------------------------------------------------------------------

async function claudeDir(projectId: string): Promise<string> {
  return path.join(await projectBaseDir(projectId), '.claude');
}

export async function getDisabledSkills(projectId: string): Promise<string[]> {
  return [...(await getDisabledSet(projectId))].sort();
}

/** True once the user has disabled at least one skill for this project. */
export async function hasDisabledSkills(projectId: string): Promise<boolean> {
  return (await getDisabledSet(projectId)).size > 0;
}

async function getDisabledSet(projectId: string): Promise<Set<string>> {
  const file = path.join(await claudeDir(projectId), STATE_FILE);
  try {
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    const arr = Array.isArray(json?.disabled) ? json.disabled : [];
    return new Set(arr.map((x: unknown) => String(x)));
  } catch {
    return new Set();
  }
}

async function writeDisabledSet(projectId: string, set: Set<string>): Promise<void> {
  const dir = await claudeDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, STATE_FILE),
    `${JSON.stringify({ disabled: [...set].sort() }, null, 2)}\n`,
    'utf8',
  );
}

// Per-project serialization: the disabled-set is read-modify-written and the
// staging dir is reshuffled, so concurrent toggles (or a toggle racing an
// agent-run sync) must not interleave or they corrupt each other.
const projectSkillLocks = new Map<string, Promise<unknown>>();
function withProjectSkillLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = projectSkillLocks.get(projectId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  projectSkillLocks.set(projectId, run.then(() => undefined, () => undefined));
  return run;
}

/** A skill id must be a single safe path segment (it indexes a dir on disk). */
function assertSafeSkillId(skillId: string): string {
  const id = String(skillId).trim();
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..') || id.startsWith('.')) {
    throw new SkillError('Invalid skill id');
  }
  return id;
}

/** Toggle a skill on/off for a project (by its on-disk id), then re-stage. */
export async function setSkillEnabled(
  projectId: string,
  skillId: string,
  enabled: boolean,
): Promise<Skill[]> {
  const id = assertSafeSkillId(skillId);
  await withProjectSkillLock(projectId, async () => {
    const set = await getDisabledSet(projectId);
    if (enabled) set.delete(id);
    else set.add(id);
    await writeDisabledSet(projectId, set);
    await syncProjectSkillsUnlocked(projectId);
  });
  const { project, global } = await listAllSkills(projectId);
  return [...project, ...global];
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function isSymlink(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Append an entry to the project's .gitignore if not already present. */
async function ensureIgnored(projectBase: string, entry: string): Promise<void> {
  const gitignore = path.join(projectBase, '.gitignore');
  try {
    let current = '';
    try {
      current = await fs.readFile(gitignore, 'utf8');
    } catch {
      // no .gitignore yet
    }
    const has = current
      .split('\n')
      .map((l) => l.trim())
      .some((l) => l === entry || l === entry.replace(/\/$/, ''));
    if (!has) {
      const prefix = current && !current.endsWith('\n') ? '\n' : '';
      await fs.appendFile(gitignore, `${prefix}\n# Claudable-managed (local only)\n${entry}\n`);
    }
  } catch {
    // best-effort
  }
}

/**
 * Reconcile the on-disk `.claude/skills` so it contains exactly the enabled
 * skills (project dirs + global symlinks). Idempotent; safe to run before every
 * agent invocation. Best-effort: failures are swallowed so a sync hiccup never
 * blocks a run.
 */
export async function syncProjectSkills(projectId: string): Promise<void> {
  await withProjectSkillLock(projectId, () => syncProjectSkillsUnlocked(projectId));
}

async function syncProjectSkillsUnlocked(projectId: string): Promise<void> {
  try {
    const base = await projectBaseDir(projectId);
    const root = await skillsDir(projectId);
    const disabledDir = path.join(root, DISABLED_SUBDIR);
    const lib = globalSkillsDir();
    const disabled = await getDisabledSet(projectId);

    await fs.mkdir(root, { recursive: true });
    // The staged `.claude/` (symlinks to ~/.claude/skills, state file) is local to
    // this Claudable instance — it must never be committed/deployed (the symlinks
    // would dangle in a built image). Keep it ignored.
    await ensureIgnored(base, '.claude/');

    // 1. Project-authored skills: park disabled ones, restore re-enabled ones.
    for (const entry of await safeReaddir(root)) {
      if (entry.startsWith('.')) continue;
      const p = path.join(root, entry);
      if (await isSymlink(p)) continue; // global staging, handled below
      let isDir = false;
      try { isDir = (await fs.stat(p)).isDirectory(); } catch { /* ignore */ }
      if (!isDir) continue;
      if (disabled.has(entry)) {
        await fs.mkdir(disabledDir, { recursive: true });
        const dest = path.join(disabledDir, entry);
        await fs.rm(dest, { recursive: true, force: true });
        await fs.rename(p, dest).catch(() => {});
      }
    }
    for (const entry of await safeReaddir(disabledDir)) {
      if (entry.startsWith('.')) continue;
      if (!disabled.has(entry)) {
        const dest = path.join(root, entry);
        if (!(await pathExists(dest))) {
          await fs.rename(path.join(disabledDir, entry), dest).catch(() => {});
        }
      }
    }

    // 2. Global skills: symlink enabled, drop disabled/stale symlinks.
    const libSkills = await safeReaddir(lib);
    for (const entry of await safeReaddir(root)) {
      if (entry.startsWith('.')) continue;
      const p = path.join(root, entry);
      if (!(await isSymlink(p))) continue;
      if (disabled.has(entry) || !libSkills.includes(entry)) {
        await fs.rm(p, { force: true }).catch(() => {});
      }
    }
    for (const entry of libSkills) {
      if (entry.startsWith('.') || disabled.has(entry)) continue;
      const target = path.join(root, entry);
      if (await pathExists(target)) continue; // don't shadow a real project skill
      await fs.symlink(path.join(lib, entry), target, 'dir').catch(() => {});
    }
  } catch {
    // best-effort — never block an agent run on staging
  }
}

/** Project-scoped (editable) skills, including disabled ones (parked). */
export async function listSkills(projectId: string): Promise<Skill[]> {
  const disabled = await getDisabledSet(projectId);
  const root = await skillsDir(projectId);
  const active = await readSkillsDir(root, 'project', { skipSymlinks: true });
  const parked = await readSkillsDir(path.join(root, DISABLED_SUBDIR), 'project');
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const s of [...active, ...parked]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ ...s, enabled: !disabled.has(s.id) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Global (shared) skills, with this project's enabled state applied. */
export async function listGlobalSkills(projectId: string): Promise<Skill[]> {
  const disabled = await getDisabledSet(projectId);
  const skills = await readSkillsDir(globalSkillsDir(), 'global');
  return skills.map((s) => ({ ...s, enabled: !disabled.has(s.id) }));
}

/** Project + global skills (both shown in the UI). */
export async function listAllSkills(projectId: string): Promise<{ project: Skill[]; global: Skill[] }> {
  const [project, global] = await Promise.all([listSkills(projectId), listGlobalSkills(projectId)]);
  return { project, global };
}

export async function getSkill(projectId: string, name: string): Promise<Skill | null> {
  const slug = normalizeSkillName(name);
  const root = await skillsDir(projectId);
  const disabled = await getDisabledSet(projectId);
  for (const file of [
    path.join(root, slug, 'SKILL.md'),
    path.join(root, DISABLED_SUBDIR, slug, 'SKILL.md'),
  ]) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = parseFrontmatter(raw);
      return {
        id: slug,
        name: parsed.name || slug,
        description: parsed.description || '',
        content: parsed.body,
        raw,
        scope: 'project',
        enabled: !disabled.has(slug),
      };
    } catch {
      // try next location
    }
  }
  return null;
}

/** Create or overwrite a skill. Accepts either a full `raw` SKILL.md or name/description/content. */
export async function saveSkill(
  projectId: string,
  input: { name: string; description?: string; content?: string; raw?: string },
): Promise<Skill> {
  const slug = normalizeSkillName(input.name);
  const root = await skillsDir(projectId);
  // Write to wherever the skill currently lives so its enabled state is preserved.
  const parked = path.join(root, DISABLED_SUBDIR, slug);
  const dir = (await pathExists(parked)) ? parked : path.join(root, slug);
  await fs.mkdir(dir, { recursive: true });

  const raw =
    input.raw && input.raw.trim().length > 0
      ? input.raw
      : buildSkillMarkdown(slug, input.description ?? '', input.content ?? '');

  await fs.writeFile(path.join(dir, 'SKILL.md'), raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');

  const disabled = await getDisabledSet(projectId);
  const parsed = parseFrontmatter(raw);
  return {
    id: slug,
    name: parsed.name || slug,
    description: parsed.description || '',
    content: parsed.body,
    raw,
    scope: 'project',
    enabled: !disabled.has(slug),
  };
}

export async function deleteSkill(projectId: string, name: string): Promise<boolean> {
  const slug = normalizeSkillName(name);
  const root = await skillsDir(projectId);
  let removed = false;
  for (const dir of [path.join(root, slug), path.join(root, DISABLED_SUBDIR, slug)]) {
    try {
      if (await pathExists(dir)) {
        await fs.rm(dir, { recursive: true, force: true });
        removed = true;
      }
    } catch {
      // ignore
    }
  }
  // Drop it from the disabled set too so a re-created skill starts enabled.
  const set = await getDisabledSet(projectId);
  if (set.delete(slug)) await writeDisabledSet(projectId, set);
  return removed;
}
