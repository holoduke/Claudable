// Injected Nuxt client plugin: route reporter + visual-editor/comments/error bridges for the preview iframe.
// The bridge itself lives in bridge-script.ts (shared with the non-Nuxt proxy/PHP paths).
import path from 'path';
import { clientLogToken } from '@/lib/services/client-log-token';
import fs from 'fs/promises';
import { ensureDirInside, readTextInside, realPathInside, writeFileInside } from '@/lib/utils/safe-fs';
import { claudableOriginFromEnv, nuxtPluginSource } from './bridge-script';

/**
 * Inject a tiny Nuxt client plugin that reports the current route to the
 * Claudable parent window via postMessage, so the preview URL bar follows
 * in-app (client-side) navigation. The preview is a cross-origin iframe, so the
 * parent can't read its location directly — this is the only reliable way.
 * The plugin is inert outside the preview iframe and is gitignored so it never
 * ships to the deployed app.
 */
const LEGACY_PLUGIN_REL = 'plugins/claudable-preview.client.ts';

/**
 * Where the preview plugin must live for Nuxt to load it. A Nuxt 4 project with
 * an app/ source dir only scans app/plugins/ — a root plugins/ file is silently
 * ignored (no route sync, visual editor or comments in that preview). A project
 * that registers the file explicitly in nuxt.config keeps the root path (moving
 * it would break that reference or load the plugin twice).
 */
export function previewPluginRelPath(nuxtConfig: string, hasAppSrcDir: boolean): string {
  if (nuxtConfig.includes('claudable-preview.client')) return LEGACY_PLUGIN_REL;
  const explicitSrcDir = /srcDir\s*:\s*['"`]([^'"`]*)['"`]/u.exec(nuxtConfig)?.[1];
  if (explicitSrcDir !== undefined) {
    const dir = explicitSrcDir.replace(/^\.\/?/u, '').replace(/\/+$/u, '');
    return dir && /^[A-Za-z0-9_-]+$/u.test(dir) ? `${dir}/plugins/claudable-preview.client.ts` : LEGACY_PLUGIN_REL;
  }
  return hasAppSrcDir ? 'app/plugins/claudable-preview.client.ts' : LEGACY_PLUGIN_REL;
}

export async function ensurePreviewRouteReporter(projectPath: string, projectId: string): Promise<void> {
  try {
    // Only meaningful for Nuxt projects.
    const hasNuxtConfig = await fs
      .access(path.join(projectPath, 'nuxt.config.ts'))
      .then(() => true)
      .catch(() => false);
    if (!hasNuxtConfig) return;

    // The exact Claudable origin, baked in so the plugin only ever posts to (and
    // accepts commands from) the real parent — not whatever page frames it.
    const claudableOrigin = claudableOriginFromEnv();

    const nuxtConfig = await readTextInside(projectPath, path.join(projectPath, 'nuxt.config.ts'));
    const appDirMarkers = await Promise.all(['app/app.vue', 'app/pages', 'app/layouts'].map((m) =>
      fs.access(path.join(/* turbopackIgnore: true */ projectPath, m)).then(() => m, () => null)));
    const rel = previewPluginRelPath(nuxtConfig, appDirMarkers.some(Boolean));
    const pluginPath = path.join(/* turbopackIgnore: true */ projectPath, rel);
    if (rel !== LEGACY_PLUGIN_REL) {
      await ensureDirInside(projectPath, path.dirname(pluginPath));
      // A copy we wrote to the root plugins/ before is not loaded under app/ —
      // remove it (only ours: identified by our header).
      const stale = path.join(projectPath, LEGACY_PLUGIN_REL);
      if ((await readTextInside(projectPath, stale)).startsWith('// Auto-added by Claudable')) {
        const real = await realPathInside(projectPath, stale);
        if (real) await fs.unlink(real).catch(() => {});
      }
    }
    // Symlink-safe: plugins/ is project (agent) content.
    await writeFileInside(projectPath, pluginPath, nuxtPluginSource({ claudableOrigin, projectId, logToken: clientLogToken(projectId), route: 'nuxt-router' }));

    // Keep it out of git / the deployed image.
    const giPath = path.join(projectPath, '.gitignore');
    const gi = await readTextInside(projectPath, giPath);
    if (!gi.includes(rel)) {
      const sep = gi.length === 0 || gi.endsWith('\n') ? '' : '\n';
      await writeFileInside(projectPath, giPath, `${gi}${sep}${rel}\n`);
    }
  } catch {
    // Non-fatal: the route bar just won't follow in-app navigation.
  }
}
