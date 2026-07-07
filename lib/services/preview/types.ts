// Shared preview types: the tracked per-project process record + the public status shape.
import type { ChildProcess } from 'child_process';

export type PreviewStatus = 'starting' | 'running' | 'stopped' | 'error';

export interface PreviewProcess {
  process: ChildProcess | null;
  // Optional backend sidecar (e.g. a Go service) proxied by the static server.
  backendProcess?: ChildProcess | null;
  // Name of the isolated backend container (when PREVIEW_ISOLATION is on).
  backendContainer?: string | null;
  // Name of the isolated frontend dev-server container (Phase 2 opt-in).
  frontendContainer?: string | null;
  // Unlinks the 0600 env-file that carried the frontend container's project env
  // (kept off the docker argv). Called on teardown; docker read the file at launch.
  frontendEnvFileCleanup?: (() => void) | null;
  // A COMPILED/production backend container is built from the project's Dockerfile
  // and does NOT hot-reload the agent's source edits. These let us rebuild+restart
  // it after a turn that changed backend files: the dir to watch, the last build
  // time, and a closure that re-does build+run+net-attach with the same params.
  backendSrcDir?: string | null;
  backendBuiltAt?: number;
  rebuildBackend?: (() => Promise<void>) | null;
  port: number;
  url: string;
  status: PreviewStatus;
  logs: string[];
  startedAt: Date;
  lastAccessedAt: Date;
}

export interface PreviewInfo {
  port: number | null;
  url: string | null;
  status: PreviewStatus;
  logs: string[];
  pid?: number;
}
