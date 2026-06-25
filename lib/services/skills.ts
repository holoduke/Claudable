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
  name: string;
  description: string;
  content: string; // body (without frontmatter)
  raw: string; // full SKILL.md
  scope: 'project' | 'global'; // project = editable; global = read-only (shared)
}

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

async function readSkillsDir(dir: string, scope: 'project' | 'global'): Promise<Skill[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    try {
      const raw = await fs.readFile(path.join(dir, entry, 'SKILL.md'), 'utf8');
      const { name, description, body } = parseFrontmatter(raw);
      skills.push({ name: name || entry, description: description || '', content: body, raw, scope });
    } catch {
      // skip dirs without a readable SKILL.md
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Project-scoped (editable) skills. */
export async function listSkills(projectId: string): Promise<Skill[]> {
  return readSkillsDir(await skillsDir(projectId), 'project');
}

/** Global (read-only, shared) skills. */
export async function listGlobalSkills(): Promise<Skill[]> {
  return readSkillsDir(globalSkillsDir(), 'global');
}

/** Project + global skills (both shown in the UI). */
export async function listAllSkills(projectId: string): Promise<{ project: Skill[]; global: Skill[] }> {
  const [project, global] = await Promise.all([listSkills(projectId), listGlobalSkills()]);
  return { project, global };
}

export async function getSkill(projectId: string, name: string): Promise<Skill | null> {
  const slug = normalizeSkillName(name);
  const file = path.join(await skillsDir(projectId), slug, 'SKILL.md');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = parseFrontmatter(raw);
    return { name: parsed.name || slug, description: parsed.description || '', content: parsed.body, raw, scope: 'project' };
  } catch {
    return null;
  }
}

/** Create or overwrite a skill. Accepts either a full `raw` SKILL.md or name/description/content. */
export async function saveSkill(
  projectId: string,
  input: { name: string; description?: string; content?: string; raw?: string },
): Promise<Skill> {
  const slug = normalizeSkillName(input.name);
  const dir = path.join(await skillsDir(projectId), slug);
  await fs.mkdir(dir, { recursive: true });

  const raw =
    input.raw && input.raw.trim().length > 0
      ? input.raw
      : buildSkillMarkdown(slug, input.description ?? '', input.content ?? '');

  await fs.writeFile(path.join(dir, 'SKILL.md'), raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');

  const parsed = parseFrontmatter(raw);
  return { name: parsed.name || slug, description: parsed.description || '', content: parsed.body, raw, scope: 'project' };
}

export async function deleteSkill(projectId: string, name: string): Promise<boolean> {
  const slug = normalizeSkillName(name);
  const dir = path.join(await skillsDir(projectId), slug);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
