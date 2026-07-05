// Per-project preview config (.claudable/preview.json), env overrides, and preview port bounds.
import path from 'path';
import fs from 'fs/promises';
import { PREVIEW_CONFIG } from '@/lib/config/constants';

/**
 * Optional per-project preview config at `.claudable/preview.json`. Lets a
 * `static` import declare a backend sidecar (e.g. a Go service) that the preview
 * builds + runs, with the static server reverse-proxying `proxy` path prefixes
 * to it. `{PROJECT}` (abs project dir) and `{PORT}` (assigned backend port) are
 * substituted in build/run/env values.
 */
export interface PreviewBackendConfig {
  cwd?: string;       // dir to build/run in, relative to the project (e.g. "backend")
  build?: string;     // shell build command (optional)
  run: string;        // shell run command (in-process/spawn mode)
  healthPath?: string;// path to probe for readiness (default "/")
  env?: Record<string, string>;
  // Isolation (used only when PREVIEW_ISOLATION is set): run the backend in a
  // hardened sibling container built from the project's own Dockerfile instead
  // of a bare in-container process.
  container?: {
    dockerfile: string;               // path relative to the project (e.g. "deploy/Dockerfile.backend")
    context?: string;                 // build context relative to the project (default ".")
    port: number;                     // port the backend LISTENS on inside the container
    memory?: string;                  // e.g. "512m"
    cpus?: string;                    // e.g. "1.0"
    pidsLimit?: number;               // default 256
    env?: Record<string, string>;     // container-side env (container paths, not host {PROJECT})
    dev?: boolean;                    // dev/watch mode: bind-mount the source + run as uid 1000
                                      //   so the in-container watcher (air / node --watch /
                                      //   uvicorn --reload) hot-reloads on the agent's edits.
    watchDir?: string;                // source dir to mount (relative to project), default "backend"
  };
}
export interface PreviewConfig {
  backend?: PreviewBackendConfig;
  proxy?: string[];   // path prefixes proxied to the backend (e.g. ["/api","/d"])
  // Phase 2 (opt-in): run this project's FRONTEND dev server in an isolated
  // container instead of a bare in-container process. Only honored when
  // PREVIEW_ISOLATION is set and the project has no database (the egress lock
  // would block a box-hosted DB). Bind-mounts the project dir into a node image.
  frontend?: {
    isolate?: boolean;
    image?: string;    // default "node:22-bookworm-slim"
    dev?: string;      // dev command, {PORT} substituted (default derived per stack)
    memory?: string;   // default "1g"
    cpus?: string;     // default "2.0"
  };
}
export async function readPreviewConfig(projectPath: string): Promise<PreviewConfig | null> {
  try {
    const raw = await fs.readFile(path.join(projectPath, '.claudable', 'preview.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as PreviewConfig) : null;
  } catch {
    return null;
  }
}
export function substVars(value: string, vars: Record<string, string>): string {
  return value.replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? vars[k] : `{${k}}`));
}

/**
 * A minimal, SECRET-FREE base env for a project's backend sidecar. Same
 * principle as the agent's buildAgentEnv allowlist: an imported/agent-edited
 * backend must NOT inherit Claudable's own credentials (CLAUDE_CODE_OAUTH_TOKEN,
 * GIT_TOKEN, COOLIFY_API_TOKEN, GOOGLE_CLIENT_SECRET, AUTH_SECRET, DATABASE_URL,
 * …). Only base runtime vars + the Go toolchain vars pass through; the backend's
 * real config/secrets come from its preview.json env + the project's Env vars.
 * NOTE: explicit names only — no `startsWith('GO')` (that would leak GOOGLE_*).
 */
const BACKEND_ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'HOSTNAME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'GOTOOLCHAIN', 'GOFLAGS', 'GOPATH', 'GOCACHE', 'GOMODCACHE', 'GOROOT',
  'GOPROXY', 'GOSUMDB', 'GO111MODULE', 'GOMAXPROCS',
]);
export function buildBackendBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v != null && BACKEND_ENV_ALLOW.has(k)) env[k] = v;
  }
  return env;
}

export interface EnvOverrides {
  port?: number;
  url?: string;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

export function parsePort(value?: string): number | null {
  if (!value) return null;
  const numeric = Number.parseInt(stripQuotes(value), 10);
  if (Number.isFinite(numeric) && numeric > 0 && numeric <= 65535) {
    return numeric;
  }
  return null;
}

const PREVIEW_FALLBACK_PORT_START = PREVIEW_CONFIG.FALLBACK_PORT_START;
const PREVIEW_FALLBACK_PORT_END = PREVIEW_CONFIG.FALLBACK_PORT_END;
const PREVIEW_MAX_PORT = 65_535;

export async function collectEnvOverrides(projectPath: string): Promise<EnvOverrides> {
  const overrides: EnvOverrides = {};
  const files = ['.env.local', '.env'];

  for (const fileName of files) {
    const filePath = path.join(projectPath, fileName);
    try {
      const contents = await fs.readFile(filePath, 'utf8');
      const lines = contents.split(/\r?\n/);
      let candidateUrl: string | null = null;

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || !line.includes('=')) {
          continue;
        }

        const [rawKey, ...rawValueParts] = line.split('=');
        const key = rawKey.trim();
        const rawValue = rawValueParts.join('=');
        const value = stripQuotes(rawValue);

        if (!overrides.port && (key === 'PORT' || key === 'WEB_PORT')) {
          const parsed = parsePort(value);
          if (parsed) {
            overrides.port = parsed;
          }
        }

        if (!overrides.url && key === 'NEXT_PUBLIC_APP_URL' && value) {
          candidateUrl = value;
        }
      }

      if (!overrides.url && candidateUrl) {
        overrides.url = candidateUrl;
      }

      if (!overrides.port && overrides.url) {
        try {
          const parsedUrl = new URL(overrides.url);
          if (parsedUrl.port) {
            const parsedPort = parsePort(parsedUrl.port);
            if (parsedPort) {
              overrides.port = parsedPort;
            }
          }
        } catch {
          // Ignore invalid URL formats
        }
      }

      if (overrides.port && overrides.url) {
        break;
      }
    } catch {
      // Missing env file is fine; skip
    }
  }

  return overrides;
}

export function resolvePreviewBounds(): { start: number; end: number } {
  const envStartRaw = Number.parseInt(process.env.PREVIEW_PORT_START || '', 10);
  const envEndRaw = Number.parseInt(process.env.PREVIEW_PORT_END || '', 10);

  const start = Number.isInteger(envStartRaw)
    ? Math.max(1, envStartRaw)
    : PREVIEW_FALLBACK_PORT_START;

  let end = Number.isInteger(envEndRaw)
    ? Math.min(PREVIEW_MAX_PORT, envEndRaw)
    : PREVIEW_FALLBACK_PORT_END;

  if (end < start) {
    end = Math.min(start + (PREVIEW_FALLBACK_PORT_END - PREVIEW_FALLBACK_PORT_START), PREVIEW_MAX_PORT);
  }

  return { start, end };
}
