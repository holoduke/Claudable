/**
 * Design Explorer — scratch cleanup. Generated mockups live under
 * data/design-canvases/<canvasId>/; remove a canvas's dir when it's deleted,
 * and sweep dirs whose canvas no longer exists (a redeploy/crash orphan).
 */
import fs from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/db/client';

function canvasesRoot(): string {
  return path.resolve(process.cwd(), 'data', 'design-canvases');
}

export async function removeCanvasScratch(canvasId: string): Promise<void> {
  if (!/^[a-z0-9]+$/i.test(canvasId)) return; // cuid — guard against traversal
  await fs.rm(path.join(canvasesRoot(), canvasId), { recursive: true, force: true }).catch(() => {});
}

/** Delete scratch dirs with no matching DesignCanvas row. Best-effort, on boot. */
export async function sweepOrphanedCanvasScratch(): Promise<void> {
  const root = canvasesRoot();
  const dirs = await fs.readdir(root).catch(() => [] as string[]);
  if (dirs.length === 0) return;
  const rows = await prisma.designCanvas.findMany({ select: { id: true } }).catch(() => []);
  const live = new Set(rows.map((r) => r.id));
  await Promise.all(
    dirs
      .filter((d) => !live.has(d))
      .map((d) => fs.rm(path.join(root, d), { recursive: true, force: true }).catch(() => {})),
  );
}
