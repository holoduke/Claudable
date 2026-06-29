/**
 * Design skills — a curated catalog (vendored from bergside/awesome-design-skills)
 * of whole-page design systems, kept SEPARATE from regular Agent Skills.
 *
 * A project has at most ONE active design (single-select). Selecting a design
 * copies its skill folder into `<project>/.claude/skills/<id>/` so the agent
 * picks it up like any other project skill; switching removes the previous one.
 * The catalog ships in the image at `design-skills/` (SKILL.md + DESIGN.md per
 * style) with preview thumbnails served from `public/design-previews/`.
 */
import fs from 'fs/promises';
import path from 'path';
import { listSkills, deleteSkill, installSkillFromDir, SkillError } from '@/lib/services/skills';

const CATALOG_DIR = path.resolve(process.cwd(), 'design-skills');

export interface DesignCatalogEntry {
  id: string;
  name: string;
  description: string;
  preview: string | null; // public path, e.g. /design-previews/minimal.png
}

let cachedCatalog: DesignCatalogEntry[] | null = null;
let cachedIds: Set<string> | null = null;

/** The full design catalog (read once, then cached). */
export async function listDesignCatalog(): Promise<DesignCatalogEntry[]> {
  if (cachedCatalog) return cachedCatalog;
  try {
    const raw = await fs.readFile(path.join(CATALOG_DIR, 'catalog.json'), 'utf8');
    cachedCatalog = JSON.parse(raw) as DesignCatalogEntry[];
  } catch {
    cachedCatalog = [];
  }
  return cachedCatalog;
}

/** Set of catalog ids — used to tell design skills apart from regular skills. */
export async function designSkillIds(): Promise<Set<string>> {
  if (cachedIds) return cachedIds;
  cachedIds = new Set((await listDesignCatalog()).map((d) => d.id));
  return cachedIds;
}

/** The id of the project's active design, or null. */
export async function getActiveDesign(projectId: string): Promise<string | null> {
  const ids = await designSkillIds();
  const skills = await listSkills(projectId);
  const active = skills.find((s) => ids.has(s.id) && s.enabled);
  return active?.id ?? null;
}

/**
 * Make `id` the project's sole active design (or clear it with null). Removes any
 * other design skills first so only one is ever present.
 */
export async function setActiveDesign(projectId: string, id: string | null): Promise<string | null> {
  const ids = await designSkillIds();
  if (id && !ids.has(id)) {
    throw new SkillError('Unknown design', 400);
  }

  // Clear every catalog design currently installed (single-select).
  const skills = await listSkills(projectId);
  for (const s of skills) {
    if (ids.has(s.id)) await deleteSkill(projectId, s.id);
  }

  if (id) {
    await installSkillFromDir(projectId, id, path.join(CATALOG_DIR, id));
  }
  return id;
}
