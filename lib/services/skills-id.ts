/**
 * Pure skill-identifier logic (no DB / filesystem). Kept in its own module so it
 * can be unit-tested without importing the prisma-backed skills service.
 */

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

/** A skill id must be a single safe path segment (it indexes a dir on disk). */
export function assertSafeSkillId(skillId: string): string {
  const id = String(skillId).trim();
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..') || id.startsWith('.')) {
    throw new SkillError('Invalid skill id');
  }
  return id;
}
