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
import { randomUUID } from 'crypto';
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
 * Capture with retries. A dev server's first compile can outlive the preview
 * readiness window (start() continues after its 60s wait), so a single early
 * capture attempt would silently miss — retry on a backoff until one succeeds
 * or the preview stops. Fire-and-forget; used by the preview-start hook.
 */
export async function captureThumbnailWithRetry(
  projectId: string,
  delaysMs: number[] = [15_000, 45_000, 120_000, 300_000],
): Promise<void> {
  for (const delay of delaysMs) {
    await new Promise((r) => setTimeout(r, delay));
    const status = previewManager.getStatus(projectId);
    if (status.status !== 'running') return; // preview stopped — give up quietly
    if (await captureThumbnail(projectId)) return;
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
  // Unique tmp per capture: the retry loop and a client-triggered POST can run
  // concurrently, and a shared tmp name made one rename fail with ENOENT.
  const tmp = `${out}.${randomUUID().slice(0, 8)}.tmp.png`;
  // Containerized previews publish on the docker-bridge gateway (PREVIEW_PUBLISH_HOST,
  // e.g. 10.0.1.1), NOT on localhost inside this container — probing localhost made
  // every capture fail (and, pre-quality-gate, saved screenshots of the browser's
  // connection-error page: the "broken" dashboard tiles).
  const publishHost = (process.env.PREVIEW_PUBLISH_HOST || process.env.DEPLOY_HOST_GATEWAY || '').trim() || 'localhost';
  const url = `http://${publishHost}:${status.port}/`;

  // Quality gate: don't screenshot a dev server that's mid-compile or erroring —
  // a broken "loading" shot is worse than keeping the previous thumbnail.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!res.ok) {
      console.log(`[thumbnail] skip capture for ${projectId}: preview returned ${res.status}`);
      return false;
    }
  } catch {
    console.log(`[thumbnail] skip capture for ${projectId}: preview not reachable yet`);
    return false; // not reachable (yet) — keep the old thumbnail
  }

  try {
    // Shoot to a temp file and rename on success, so a failed/blank capture
    // never clobbers a good previous thumbnail.
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
        `--screenshot=${tmp}`,
        url,
      ],
      { timeout: 30_000 },
    );
    const st = await fs.stat(tmp);
    if (st.size === 0) throw new Error('empty screenshot');
    await fs.rename(tmp, out);
    return true;
  } catch (error) {
    console.error('[thumbnail] capture failed for', projectId, error);
    await fs.rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}
