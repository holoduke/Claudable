/**
 * Project thumbnails — a headless screenshot of the project's running preview,
 * shown on the dashboard tiles.
 *
 * Capture uses the system Chromium (installed in the image) in headless mode via
 * its CLI `--screenshot` flag, so there's no extra Node dependency. It only works
 * while the project's preview is running (we hit it on localhost:<port> inside the
 * same container). Thumbnails are stored under data/thumbnails/<id>.png and served
 * by the GET route; they're regenerable, so losing them on redeploy is harmless.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { previewManager } from './preview';

const execFileP = promisify(execFile);

const THUMBS_DIR = path.isAbsolute(process.env.THUMBNAILS_DIR || '')
  ? (process.env.THUMBNAILS_DIR as string)
  : path.resolve(process.cwd(), process.env.THUMBNAILS_DIR || 'data/thumbnails');
const CHROMIUM = process.env.CHROMIUM_PATH || 'chromium';

function safeId(projectId: string): string {
  const safe = String(projectId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) throw new Error('Invalid project id');
  return safe;
}

export function thumbnailFile(projectId: string): string {
  return path.join(THUMBS_DIR, `${safeId(projectId)}.png`);
}

export async function getThumbnail(projectId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(thumbnailFile(projectId));
  } catch {
    return null;
  }
}

/**
 * Screenshot the project's running preview. Returns true on success. No-op (false)
 * if the preview isn't running — there's nothing to capture.
 */
export async function captureThumbnail(projectId: string): Promise<boolean> {
  const status = previewManager.getStatus(projectId);
  if (status.status !== 'running' || !status.port) return false;

  await fs.mkdir(THUMBS_DIR, { recursive: true });
  const out = thumbnailFile(projectId);
  const url = `http://localhost:${status.port}/`;

  try {
    await execFileP(
      CHROMIUM,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--window-size=1280,800',
        '--virtual-time-budget=5000', // let the dev server render before the shot
        `--screenshot=${out}`,
        url,
      ],
      { timeout: 30_000 },
    );
    const st = await fs.stat(out);
    return st.size > 0;
  } catch (error) {
    console.error('[thumbnail] capture failed for', projectId, error);
    return false;
  }
}
