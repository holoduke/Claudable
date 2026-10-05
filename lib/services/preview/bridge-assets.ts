// Per-project preview-bridge runtime files (Claudable-owned, under the data dir)
// and the container wiring that delivers the bridge to non-Nuxt stacks.
import path from 'path';
import fs from 'fs/promises';
import type { StackKind } from '@/lib/config/stacks';
import type { PreviewConfig } from './config';
import { bridgeCoreSource, bridgeOptionsFor } from './bridge-script';
import { BRIDGE_CONTAINER_PORT, BRIDGE_PROXY_SRC } from './bridge-proxy';
import { BRIDGE_INJECT_PHP, BRIDGE_PHP_INI_DIR, BRIDGE_PHP_INI_FILE, bridgePhpIni } from './bridge-php';

/** Where the bridge dir is mounted (read-only) inside a preview container. */
export const BRIDGE_MOUNT = '/opt/claudable-bridge';
/** The official-PHP-image conf.d (webdevops/php builds on it). */
export const PHP_CONF_D_TARGET = '/usr/local/etc/php/conf.d/zz-claudable-bridge.ini';

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;

/** Data root (parent of PROJECTS_DIR) — same derivation as the per-project package caches. */
function dataRoot(): string {
  return path.resolve(path.dirname(process.env.PROJECTS_DIR || './data/projects'));
}

/** Parent of all per-project bridge dirs (project-wipe.ts removes `<this>/<id>`). */
export function bridgeProjectsRoot(): string {
  return path.join(dataRoot(), '.preview-bridge', 'projects');
}

export function bridgeDirFor(projectId: string): string {
  if (!PROJECT_ID_RE.test(projectId)) throw new Error('unsafe project id for a bridge path');
  return path.join(bridgeProjectsRoot(), projectId);
}

/** PREVIEW_BRIDGE_PROXY=0 (or false/off) disables the proxy/PHP/static injection globally. */
export function bridgeGloballyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PREVIEW_BRIDGE_PROXY ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** Global switch plus the per-project `.claudable/preview.json` `"bridge": false`. */
export function bridgeEnabledFor(cfg: PreviewConfig | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return bridgeGloballyEnabled(env) && cfg?.bridge !== false;
}

/**
 * Write (every preview start, so updates reach running projects on restart)
 * the project's bridge files: bridge.js (history-routed core), proxy.cjs,
 * inject.php and php/claudable-bridge.ini. Returns the LOCAL dir.
 */
export async function writeBridgeAssets(projectId: string): Promise<string> {
  const dir = bridgeDirFor(projectId);
  await fs.mkdir(path.join(dir, BRIDGE_PHP_INI_DIR), { recursive: true, mode: 0o755 });
  const files: [string, string][] = [
    ['bridge.js', bridgeCoreSource(bridgeOptionsFor(projectId, 'history'))],
    ['proxy.cjs', BRIDGE_PROXY_SRC],
    ['inject.php', BRIDGE_INJECT_PHP],
    [path.join(BRIDGE_PHP_INI_DIR, BRIDGE_PHP_INI_FILE), bridgePhpIni(BRIDGE_MOUNT)],
  ];
  // Readable by the container user (uid 1000 / node), written only by Claudable.
  await Promise.all(files.map(([name, body]) => fs.writeFile(path.join(dir, name), body, { encoding: 'utf8', mode: 0o644 })));
  return dir;
}

export type ContainerBridgeMode = 'none' | 'proxy' | 'php';

export interface ContainerBridgeInput {
  kind: StackKind;
  enabled: boolean;
  /** Root nuxt.config.ts exists → the Nuxt plugin (route-reporter.ts) carries the bridge. */
  hasNuxtPlugin: boolean;
  /** The proxy needs node: only the default node image is guaranteed to have it. */
  usesDefaultNodeImage: boolean;
  effectivePort: number;
}

export function containerBridgeMode(i: ContainerBridgeInput): ContainerBridgeMode {
  if (!i.enabled) return 'none';
  if (i.kind === 'laravel') return 'php';
  if (i.hasNuxtPlugin) return 'none';
  if (!i.usesDefaultNodeImage || i.effectivePort === BRIDGE_CONTAINER_PORT) return 'none';
  return 'proxy';
}

export interface ContainerBridgePlan {
  /** Container port the host publish maps to. */
  containerPort: number;
  mountArgs: string[];
  env: Record<string, string>;
  /** Wraps the container's `sh -c` script. */
  wrap: (devScript: string) => string;
}

/**
 * docker-run changes per mode. `hostDir` is the HOST path of the bridge dir
 * (toHostPath of writeBridgeAssets' result — it lies under the data root, which
 * the socket-proxy create policy allows as a bind source).
 */
export function containerBridgePlan(mode: ContainerBridgeMode, hostDir: string, effectivePort: number): ContainerBridgePlan {
  if (mode === 'proxy') {
    return {
      containerPort: BRIDGE_CONTAINER_PORT,
      mountArgs: ['-v', `${hostDir}:${BRIDGE_MOUNT}:ro`],
      env: {},
      // Proxy in the background, then the unchanged dev script (whose own
      // `exec` keeps the dev server as the process the container lives on).
      wrap: (devScript) => `node ${BRIDGE_MOUNT}/proxy.cjs ${BRIDGE_CONTAINER_PORT} ${effectivePort} & ${devScript}`,
    };
  }
  if (mode === 'php') {
    return {
      containerPort: effectivePort,
      mountArgs: [
        '-v', `${hostDir}:${BRIDGE_MOUNT}:ro`,
        // `php artisan serve` re-spawns `php -S` with a filtered env (Laravel
        // passes only an allowlist of vars it saw in $_ENV), so the scan-dir env
        // alone may not reach the web server — also drop the fragment into the
        // image's own conf.d. Loading it twice is harmless (same directive).
        '-v', `${hostDir}/${BRIDGE_PHP_INI_DIR}/${BRIDGE_PHP_INI_FILE}:${PHP_CONF_D_TARGET}:ro`,
      ],
      // Leading ':' = append to the compiled-in scan dir instead of replacing it.
      env: { PHP_INI_SCAN_DIR: `:${BRIDGE_MOUNT}/${BRIDGE_PHP_INI_DIR}` },
      wrap: (devScript) => devScript,
    };
  }
  return { containerPort: effectivePort, mountArgs: [], env: {}, wrap: (devScript) => devScript };
}

export interface PrepareContainerBridgeInput {
  projectId: string;
  projectPath: string;
  cfg: PreviewConfig | null;
  kind: StackKind;
  image: string;
  defaultNodeImage: string;
  effectivePort: number;
  /** Local path → HOST path for docker -v sources (docker.ts toHostPath). */
  toHostPath: (p: string) => string;
  log: (chunk: Buffer | string) => void;
}

/**
 * Decide + prepare how the bridge reaches this container. Best-effort: when the
 * files cannot be written the container runs exactly as before (no bridge).
 */
export async function prepareContainerBridge(i: PrepareContainerBridgeInput): Promise<ContainerBridgePlan & { mode: ContainerBridgeMode }> {
  const hasNuxtPlugin = await fs.access(path.join(/* turbopackIgnore: true */ i.projectPath, 'nuxt.config.ts')).then(() => true, () => false);
  const mode = containerBridgeMode({
    kind: i.kind,
    enabled: bridgeEnabledFor(i.cfg),
    hasNuxtPlugin,
    usesDefaultNodeImage: i.image === i.defaultNodeImage,
    effectivePort: i.effectivePort,
  });
  if (mode === 'none') return { mode, ...containerBridgePlan('none', '', i.effectivePort) };
  try {
    const dir = await writeBridgeAssets(i.projectId);
    i.log(Buffer.from(`[PreviewManager] [bridge] preview bridge via ${mode === 'proxy' ? `proxy on container port ${BRIDGE_CONTAINER_PORT}` : 'PHP auto_prepend_file'}`));
    return { mode, ...containerBridgePlan(mode, i.toHostPath(dir), i.effectivePort) };
  } catch (e) {
    i.log(Buffer.from(`[PreviewManager] [bridge] disabled for this start: ${(e as Error).message}`));
    return { mode: 'none', ...containerBridgePlan('none', '', i.effectivePort) };
  }
}

/**
 * The static preview server (Claudable's own code, run by Claudable) serves
 * the bridge itself; returns the local bridge.js path, or null when disabled.
 */
export async function prepareStaticBridge(projectId: string, cfg: PreviewConfig | null, log: (chunk: Buffer | string) => void): Promise<string | null> {
  if (!bridgeEnabledFor(cfg)) return null;
  try {
    return path.join(await writeBridgeAssets(projectId), 'bridge.js');
  } catch (e) {
    log(Buffer.from(`[PreviewManager] [bridge] disabled for this start: ${(e as Error).message}`));
    return null;
  }
}
