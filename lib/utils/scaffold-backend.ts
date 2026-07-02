/**
 * Scaffold a project's optional backend: write the starter files (server +
 * Dockerfile) from the backend registry and record the backend container config
 * in `.claudable/preview.json` so the preview runs it as an isolated service.
 * No-op if the backend already exists (never clobbers agent-edited code).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { getBackendStack, type BackendKind } from '@/lib/config/backend-stacks';

export async function scaffoldBackend(projectPath: string, backendId: BackendKind): Promise<void> {
  const stack = getBackendStack(backendId);
  if (!stack) return;

  // Don't overwrite an existing backend (e.g. re-runs, or the agent has edited it).
  const backendDir = path.join(projectPath, 'backend');
  const exists = await fs.access(backendDir).then(() => true).catch(() => false);

  if (!exists) {
    const files = stack.files({ corsOrigin: '*' });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(projectPath, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, 'utf8');
    }
  }

  // Record the backend in preview.json (merge; the preview runs it isolated).
  const cfgPath = path.join(projectPath, '.claudable', 'preview.json');
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
  } catch {
    /* none yet */
  }
  cfg.backend = {
    ...(typeof cfg.backend === 'object' && cfg.backend ? cfg.backend : {}),
    healthPath: '/api/health',
    container: {
      dockerfile: 'backend/Dockerfile',
      context: '.',
      port: stack.port,
      env: { PORT: String(stack.port) },
    },
  };
  if (!Array.isArray(cfg.proxy)) cfg.proxy = ['/api'];
  await fs.mkdir(path.dirname(cfgPath), { recursive: true });
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}
