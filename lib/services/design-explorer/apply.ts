/**
 * Design Explorer — apply. Staging a chosen frame mirrors design-import exactly:
 * write the mockup into `<repo>/design-reference/` as a `.dc.html` screen and
 * build an editable port instruction with `buildPortPrompt`. The caller returns
 * that prompt to the client, which runs it through the normal act pipeline — so
 * "Use this design" gets checkpointing + "Revert to here" for free.
 */
import fs from 'fs/promises';
import path from 'path';
import { buildPortPrompt, type DesignImportManifest } from '@/lib/services/design-import';
import { prisma } from '@/lib/db/client';

const DEST_DIRNAME = 'design-reference';

async function ensureGitignored(projectPath: string): Promise<void> {
  const gitignorePath = path.join(projectPath, '.gitignore');
  const entry = `${DEST_DIRNAME}/`;
  try {
    let current = '';
    try { current = await fs.readFile(gitignorePath, 'utf8'); } catch { /* none yet */ }
    const has = current.split('\n').map((l) => l.trim()).some((l) => l === entry || l === DEST_DIRNAME);
    if (!has) {
      const prefix = current && !current.endsWith('\n') ? '\n' : '';
      await fs.appendFile(gitignorePath, `${prefix}\n# Design reference (not shipped)\n${entry}\n`);
    }
  } catch { /* best-effort */ }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '') || 'design';
}

/**
 * Stage a frame's HTML into the project's design-reference/ and return a ready
 * (editable) port prompt. Throws if the frame has no rendered HTML.
 */
export async function stageFrameForPort(
  projectPath: string,
  frameId: string,
): Promise<{ manifest: DesignImportManifest; suggestedPrompt: string }> {
  const frame = await prisma.designFrame.findUnique({ where: { id: frameId } });
  if (!frame || !frame.htmlPath) throw new Error('Frame has no rendered design to apply');
  const html = await fs.readFile(frame.htmlPath, 'utf8');

  const dir = path.join(projectPath, DEST_DIRNAME);
  await fs.mkdir(dir, { recursive: true });
  const screen = slug(frame.styleName || frame.styleId || 'design');
  const fileName = `${screen}.dc.html`;
  await fs.writeFile(path.join(dir, fileName), html, 'utf8');
  await ensureGitignored(projectPath);

  const manifest: DesignImportManifest = {
    dir: DEST_DIRNAME,
    screens: [screen],
    designSystemPresent: false,
    assetCount: 0,
    fontCount: 0,
    fileCount: 1,
    totalBytes: Buffer.byteLength(html),
    skippedNoise: 0,
  };
  return { manifest, suggestedPrompt: buildPortPrompt(manifest) };
}
