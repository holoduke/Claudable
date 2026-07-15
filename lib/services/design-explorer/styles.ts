/**
 * Design Explorer — style seeding. Each generated frame is seeded with a
 * different style from the design catalog (design-skills/<id>/DESIGN.md) so the
 * variations feel genuinely distinct instead of near-duplicates.
 */
import fs from 'fs/promises';
import path from 'path';
import { listDesignCatalog, type DesignCatalogEntry } from '@/lib/services/design-skills';

const CATALOG_DIR = path.resolve(process.cwd(), 'design-skills');

/** The raw DESIGN.md spec (frontmatter tokens + guidance) for a catalog style,
 *  or null if the style has no readable spec. Used to seed a generation prompt. */
export async function readDesignSpec(id: string): Promise<string | null> {
  // Guard the id so it can't escape the catalog dir.
  if (!/^[a-z0-9-]+$/i.test(id)) return null;
  try {
    return await fs.readFile(path.join(CATALOG_DIR, id, 'DESIGN.md'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Pick `n` distinct catalog styles, spread across the catalog for variety.
 * Even-interval sampling keeps the selection deterministic (stable frames on
 * retry) while still covering very different aesthetics. Returns fewer than `n`
 * only if the catalog itself is smaller.
 */
export async function pickDiverseStyles(n: number): Promise<DesignCatalogEntry[]> {
  const catalog = await listDesignCatalog();
  if (catalog.length === 0 || n <= 0) return [];
  if (n >= catalog.length) return catalog.slice();
  const step = catalog.length / n;
  const picked: DesignCatalogEntry[] = [];
  for (let i = 0; i < n; i += 1) {
    picked.push(catalog[Math.floor(i * step)]);
  }
  return picked;
}
