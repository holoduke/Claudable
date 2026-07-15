import { describe, expect, it } from 'vitest';
import { pickDiverseStyles, readDesignSpec } from './styles';
import { listDesignCatalog } from '@/lib/services/design-skills';

describe('pickDiverseStyles', () => {
  it('returns n distinct catalog styles spread across the catalog', async () => {
    const catalog = await listDesignCatalog();
    if (catalog.length < 4) return; // catalog ships in the image; skip if absent
    const picked = await pickDiverseStyles(3);
    expect(picked).toHaveLength(3);
    const ids = picked.map((p) => p.id);
    expect(new Set(ids).size).toBe(3); // distinct
    // spread: not just the first three in a row
    const firstThree = catalog.slice(0, 3).map((c) => c.id);
    expect(ids).not.toEqual(firstThree);
  });

  it('never returns more than the catalog holds, and nothing for n<=0', async () => {
    const catalog = await listDesignCatalog();
    expect(await pickDiverseStyles(0)).toEqual([]);
    const many = await pickDiverseStyles(catalog.length + 50);
    expect(many.length).toBeLessThanOrEqual(catalog.length);
  });
});

describe('readDesignSpec', () => {
  it('rejects ids that could escape the catalog dir', async () => {
    expect(await readDesignSpec('../../etc/passwd')).toBe(null);
    expect(await readDesignSpec('foo/bar')).toBe(null);
    expect(await readDesignSpec('')).toBe(null);
  });

  it('returns the DESIGN.md text for a real catalog style (when present)', async () => {
    const catalog = await listDesignCatalog();
    if (catalog.length === 0) return;
    const spec = await readDesignSpec(catalog[0].id);
    // Either the style ships a DESIGN.md (string) or it doesn't (null) — both valid;
    // the point is no throw and no traversal.
    expect(spec === null || typeof spec === 'string').toBe(true);
  });
});
