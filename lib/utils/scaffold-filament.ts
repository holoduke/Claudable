/**
 * Filament (Laravel) scaffold — clones the NewStory golden Filament template
 * and re-slugs it for the new project.
 *
 * WHY a private clone instead of an in-repo template: the golden template's
 * `src/composer.json` embeds a live gemfury private-registry token in a
 * repository URL. Claudable's own repo is public, so the template can't be
 * vendored here without leaking that credential. Instead it lives in a PRIVATE
 * Gitea repo (default `<GIT_ORG>/filament-template`) which Claudable clones with
 * its server-side `GIT_TOKEN`. The token never enters the project files, and it
 * never reaches the preview sandbox (which scrubs GIT_TOKEN) — the container
 * only runs `composer install`, whose gemfury auth rides in composer.json and
 * resolves over the sandbox's public-internet egress.
 *
 * The template keeps the Laravel app under `src/` (build/deployment reference
 * `./src`); the preview run path (`filamentDevScript`) runs artisan from there.
 * Placeholder `storyabletpl` is replaced with the project slug throughout.
 */
import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { getGitProviderConfig, getEnvGitToken } from '@/lib/services/git-provider';

const execFileAsync = promisify(execFile);

const PLACEHOLDER = 'storyabletpl';
// Sentinel that proves the template is already laid down — the template's
// Laravel app lives under src/, so this is the reliable "scaffolded" marker.
const SENTINEL = path.join('src', 'composer.json');
// Files/dirs we must never overwrite when merging the template into a project
// dir that Claudable already populated (agent config, preview plumbing, git).
const PRESERVE = new Set(['.git', '.claude', '.claudable', 'node_modules']);
// Extensions we skip when doing the placeholder text-replace (binary assets).
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.woff', '.woff2',
  '.ttf', '.eot', '.otf', '.pdf', '.zip', '.gz', '.tar', '.mp4', '.mov', '.avi',
  '.wasm', '.map',
]);

/** Sluggify per the NewStory convention: lowercase, strip non-alphanumeric. */
export function filamentSlug(name: string | null | undefined, projectId: string): string {
  const fromName = (name || '').toLowerCase().replace(/[^a-z0-9]/gu, '');
  if (fromName.length >= 2) return fromName;
  // Fall back to the project id (also slugged) so the value is always valid and
  // unique even when the human name is empty or all-punctuation.
  const fromId = projectId.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return fromId.length >= 2 ? fromId : `filament${fromId}`;
}

/** Resolve the private template repo clone URL (with embedded token). */
function templateCloneUrl(): { url: string; redacted: string } {
  const token = getEnvGitToken();
  if (!token) {
    throw new Error(
      'Cannot scaffold Filament project: GIT_TOKEN is not set, so the private ' +
      'filament-template repo cannot be cloned. Configure GIT_TOKEN (a Gitea ' +
      'token with read access) on the Claudable server.',
    );
  }
  const { httpBase, org } = getGitProviderConfig();
  if (!org) {
    throw new Error(
      'Cannot scaffold Filament project: GIT_ORG is not set. The filament-template ' +
      'repo is expected under that org.',
    );
  }
  const repo = process.env.FILAMENT_TEMPLATE_REPO?.trim() || 'filament-template';
  // repo may be given as "org/name" or just "name" (resolved under GIT_ORG).
  const fullName = repo.includes('/') ? repo : `${org}/${repo}`;
  const host = httpBase.replace(/^https?:\/\//u, '');
  return {
    url: `https://oauth2:${token}@${host}/${fullName}.git`,
    redacted: `https://oauth2:***@${host}/${fullName}.git`,
  };
}

/** Recursively replace the placeholder with the slug in text files under dir. */
async function reslugTree(dir: string, slug: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await reslugTree(full, slug);
      continue;
    }
    if (!entry.isFile()) continue;
    if (BINARY_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    const stat = await fs.stat(full);
    if (stat.size > 2 * 1024 * 1024) continue; // skip large files (lockfiles etc.)
    const contents = await fs.readFile(full, 'utf8').catch(() => null);
    if (contents === null || !contents.includes(PLACEHOLDER)) continue;
    await fs.writeFile(full, contents.split(PLACEHOLDER).join(slug), 'utf8');
  }
}

/** Merge srcDir into destDir without clobbering PRESERVE'd or existing files. */
async function mergeNoClobber(srcDir: string, destDir: string, top = true): Promise<void> {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (top && PRESERVE.has(entry.name)) continue;
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(to, { recursive: true });
      await mergeNoClobber(from, to, false);
    } else if (entry.isFile()) {
      // No-clobber: keep any file Claudable already placed at this path.
      try {
        await fs.access(to);
      } catch {
        await fs.copyFile(from, to);
      }
    }
  }
}

/**
 * Clone + re-slug the golden Filament template into an existing project dir.
 * Idempotent: returns early once `src/composer.json` is present, so the
 * preview's scaffold-gate can call it on every start without re-cloning.
 */
export async function scaffoldFilamentApp(
  projectPath: string,
  projectId: string,
  projectName?: string | null,
): Promise<void> {
  await fs.mkdir(projectPath, { recursive: true });
  // Already scaffolded → nothing to do.
  try {
    await fs.access(path.join(projectPath, SENTINEL));
    return;
  } catch {
    /* proceed to scaffold */
  }

  const slug = filamentSlug(projectName, projectId);
  const { url, redacted } = templateCloneUrl();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filament-tpl-'));

  try {
    console.log(`[scaffold-filament] cloning template ${redacted} → project ${projectId} (slug ${slug})`);
    await execFileAsync('git', ['clone', '--depth', '1', '--no-single-branch', url, tmpDir], {
      // Never prompt for credentials — fail fast with a clear error instead.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 32 * 1024 * 1024,
    });
    // Drop the template's own history so the project starts clean.
    await fs.rm(path.join(tmpDir, '.git'), { recursive: true, force: true });
    await reslugTree(tmpDir, slug);
    await mergeNoClobber(tmpDir, projectPath);
    console.log(`[scaffold-filament] template ready for project ${projectId}`);
  } catch (err) {
    // Surface a clear, actionable error; the caller logs it into the preview.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Filament template scaffold failed: ${msg.replace(/oauth2:[^@]+@/gu, 'oauth2:***@')}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
