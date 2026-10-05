/**
 * Design Import — stage a Claude Design (claude.ai/design) zip export into a
 * project so the agent can port the screens into the app.
 *
 * A Claude Design export is a set of self-contained `*.dc.html` mockups (a
 * `<helmet>` block for fonts/global CSS plus inline-styled markup using a small
 * `<sc-for>` / `{{ mustache }}` template language), a `fonts/` folder and an
 * `assets/` folder. The rest of the archive (`screenshots/`, `uploads/`, PDFs,
 * the canvas runtime js, thumbnails) is design-process noise and is dropped.
 *
 * These are mockups, not framework components — so "applying" a design means the
 * agent reads the staged files and translates them into the app's own component
 * structure. This module only handles the plumbing: filter, extract (path-safe),
 * and describe what was imported.
 */

import fs from 'fs/promises';
import path from 'path';
import { unzipSync } from 'fflate';
import { shouldKeep, commonRootPrefix, screenName } from '@/lib/utils/design-keep';
import { readTextInside, realPathInside, writeFileInside } from '@/lib/utils/safe-fs';

const DEST_DIRNAME = 'design-reference';

/** Largest design zip we import (the browser pre-filters, so the upload is usually far smaller). */
export const MAX_DESIGN_UPLOAD_BYTES = 600 * 1024 * 1024;

export type DesignImportErrorCode = 'unreadable' | 'not_design_export' | 'invalid_upload' | 'upload_missing' | 'too_large';

/** A failure the import UI can explain in the viewer's language (via `code`). */
export class DesignImportError extends Error {
  constructor(readonly code: DesignImportErrorCode, message: string, readonly params: Record<string, number> = {}) {
    super(message);
    this.name = 'DesignImportError';
  }
}

// A chunked upload finalizes as assets/<uuid><ext> (see /api/assets/:id/upload).
const STAGED_UPLOAD_RE = /^assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.zip$/u;

export function tooLargeError(sizeBytes: number): DesignImportError {
  const size = Math.ceil(sizeBytes / 1024 / 1024);
  const limit = MAX_DESIGN_UPLOAD_BYTES / 1024 / 1024;
  return new DesignImportError('too_large', `Zip is too large (${size} MB). Limit is ${limit} MB.`, { size, limit });
}

/**
 * Read a design zip that arrived through the CHUNKED asset upload (a single
 * request body is capped at ~10MB by the proxies, so large exports can't be
 * posted in one go). `uploadPath` is the upload's "assets/<uuid>.zip"; it must
 * resolve — symlinks included — to a regular file inside `<projectDir>/assets`
 * (that folder is agent-writable). Returns the bytes and the absolute path so
 * the caller can delete the staged zip after the import.
 */
export async function readStagedDesignUpload(projectDir: string, uploadPath: unknown): Promise<{ bytes: Uint8Array; absolutePath: string }> {
  if (typeof uploadPath !== 'string' || !STAGED_UPLOAD_RE.test(uploadPath)) {
    throw new DesignImportError('invalid_upload', 'Invalid upload reference.');
  }
  const assetsDir = path.join(projectDir, 'assets');
  const target = path.join(projectDir, uploadPath);
  const lst = await fs.lstat(target).catch(() => null);
  const real = lst && !lst.isSymbolicLink() ? await realPathInside(assetsDir, target) : null;
  const stat = real ? await fs.stat(real).catch(() => null) : null;
  if (!real || !stat?.isFile()) throw new DesignImportError('upload_missing', 'The uploaded file was not found — upload it again.');
  if (stat.size > MAX_DESIGN_UPLOAD_BYTES) {
    await fs.rm(real, { force: true }).catch(() => {});
    throw tooLargeError(stat.size);
  }
  return { bytes: new Uint8Array(await fs.readFile(real)), absolutePath: real };
}

export interface DesignImportManifest {
  /** Directory (relative to project root) the design was staged into. */
  dir: string;
  /** Screen/component names derived from the `*.dc.html` files. */
  screens: string[];
  /** Whether a "Design System" screen (tokens: colour/type/spacing) is present. */
  designSystemPresent: boolean;
  assetCount: number;
  fontCount: number;
  /** Total files written to disk. */
  fileCount: number;
  /** Total bytes written. */
  totalBytes: number;
  /** Archive entries skipped as noise (screenshots/uploads/etc.). */
  skippedNoise: number;
}

/**
 * Extract a Claude Design zip (kept entries only) into `<projectPath>/design-reference/`.
 * Replaces any previous staging. Returns a manifest describing the import.
 */
export async function extractDesignImport(
  zip: Uint8Array,
  projectPath: string
): Promise<DesignImportManifest> {
  const destRoot = path.resolve(projectPath, DEST_DIRNAME);

  // Decompress only the entries we keep — `filter` skips inflating the noise
  // (screenshots/uploads can be hundreds of MB) so memory stays bounded.
  let skippedNoise = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip, {
      filter: (file) => {
        const keep = shouldKeep(file.name);
        if (!keep) skippedNoise++;
        return keep;
      },
    });
  } catch (error) {
    throw new DesignImportError(
      'unreadable',
      `Could not read the zip archive: ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }

  const dcEntries = Object.keys(files).filter((n) => n.toLowerCase().endsWith('.dc.html'));
  if (dcEntries.length === 0) {
    throw new DesignImportError(
      'not_design_export',
      "This doesn't look like a Claude Design export — no .dc.html screens were found in the zip."
    );
  }

  // Strip a single wrapper directory if the whole archive is nested in one.
  const prefix = commonRootPrefix(Object.keys(files));

  // Fresh import: clear any previous staging so removed screens don't linger.
  await fs.rm(destRoot, { recursive: true, force: true });
  await fs.mkdir(destRoot, { recursive: true });

  const screens: string[] = [];
  let assetCount = 0;
  let fontCount = 0;
  let totalBytes = 0;
  let fileCount = 0;
  let designSystemPresent = false;

  for (const [name, data] of Object.entries(files)) {
    const relName = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (!relName) continue;
    // Path-traversal containment: never write outside design-reference/.
    const outPath = path.resolve(destRoot, relName);
    if (outPath !== destRoot && !outPath.startsWith(destRoot + path.sep)) {
      continue;
    }
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, Buffer.from(data));
    fileCount++;
    totalBytes += data.length;

    const lower = relName.toLowerCase();
    if (lower.endsWith('.dc.html')) {
      const s = screenName(relName);
      screens.push(s);
      if (/design\s*system/i.test(s)) designSystemPresent = true;
    } else if (/(^|\/)fonts\//.test(relName)) {
      fontCount++;
    } else if (/(^|\/)assets\//.test(relName)) {
      assetCount++;
    }
  }

  screens.sort((a, b) => a.localeCompare(b));

  const manifest: DesignImportManifest = {
    dir: DEST_DIRNAME,
    screens,
    designSystemPresent,
    assetCount,
    fontCount,
    fileCount,
    totalBytes,
    skippedNoise,
  };

  await writeIndex(destRoot, manifest);
  await ensureGitignored(projectPath, DEST_DIRNAME);

  return manifest;
}

/**
 * A short guide written alongside the staged files so the agent (and the user)
 * knows what the folder contains and how the `.dc.html` format works.
 */
async function writeIndex(destRoot: string, m: DesignImportManifest): Promise<void> {
  const lines = [
    '# Imported Claude Design reference',
    '',
    'Staged from a claude.ai/design export. These are **visual mockups to port**,',
    'not framework components — translate them into this app, do not copy them in.',
    '',
    '## Screens (`*.dc.html`)',
    ...m.screens.map((s) => `- ${s}`),
    '',
    '## Format notes',
    '- Each `*.dc.html` is self-contained HTML: a `<helmet>` block (fonts + global',
    '  CSS, e.g. colours, `::selection`, base typography) plus inline-styled markup.',
    '- A small template language appears in some files: `<sc-for list="{{ items }}"',
    '  as="x">…</sc-for>` loops and `{{ mustache }}` interpolation. Treat these as',
    '  "render this block per item" — they map to `v-for`/list rendering.',
    '- Images referenced as `assets/…` live in `./assets/`. Fonts live in `./fonts/`.',
    `- ${m.designSystemPresent ? 'A **Design System** screen defines the tokens (colour/type/spacing) — adopt it first.' : 'No dedicated Design System screen; infer tokens from the shared header/footer.'}`,
    '',
    '## How to port',
    '1. Adopt the design system: colours, fonts (copy `fonts/` into the app and',
    "   register them), spacing and base typography into the app's styling config.",
    '2. Port shared chrome first (header/footer), then pages.',
    '3. Rebuild each screen using the app\'s own components and conventions',
    '   (do not paste raw inline-styled HTML). Copy referenced images from',
    '   `assets/` into the app\'s public/static location.',
    '4. Keep the existing routing/i18n/structure intact.',
    '',
    `_${m.fileCount} files, ${(m.totalBytes / 1024 / 1024).toFixed(1)} MB kept; ${m.skippedNoise} noise entries skipped._`,
    '',
  ];
  await fs.writeFile(path.join(destRoot, 'INDEX.md'), lines.join('\n'), 'utf8');
}

/** Ensure the staging dir is gitignored so it never gets committed/deployed. */
async function ensureGitignored(projectPath: string, dirName: string): Promise<void> {
  const gitignorePath = path.join(projectPath, '.gitignore');
  const entry = `${dirName}/`;
  try {
    const current = await readTextInside(projectPath, gitignorePath);
    const has = current
      .split('\n')
      .map((l) => l.trim())
      .some((l) => l === entry || l === dirName);
    if (!has) {
      const prefix = current && !current.endsWith('\n') ? '\n' : '';
      await writeFileInside(
        projectPath,
        gitignorePath,
        `${current}${prefix}\n# Claude Design import (reference only, not shipped)\n${entry}\n`,
      );
    }
  } catch {
    // gitignore is best-effort; staging still works without it.
  }
}

/**
 * Build a ready-to-send agent instruction for porting the staged design.
 * Returned to the UI as an editable prompt.
 */
export function buildPortPrompt(m: DesignImportManifest): string {
  const screenList = m.screens.join(', ');
  const first = m.designSystemPresent
    ? 'Start with the **Design System** screen — adopt its colours, fonts (copy the files from `design-reference/fonts/` into the app and register them) and base typography/spacing into our styling config.'
    : 'Start by extracting the shared visual tokens (colours, fonts, spacing) from the header/footer and applying them to our styling config.';
  return [
    `I imported a Claude Design export into \`${m.dir}/\` (see \`${m.dir}/INDEX.md\`).`,
    '',
    `Port these designs into our existing app, keeping our current framework, routing, i18n and component structure — these \`.dc.html\` files are mockups to translate, not code to paste in.`,
    '',
    first,
    '',
    `Then rebuild the screens to match the designs, reusing our components and copying any referenced images from \`${m.dir}/assets/\` into our public/static folder. Screens available: ${screenList}.`,
    '',
    `Begin with the shared header and footer, then do the pages. Show me a short plan first.`,
  ].join('\n');
}
