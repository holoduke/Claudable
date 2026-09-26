/**
 * What a project's own `.claudable/preview.json` may decide.
 *
 * The file lives inside the project, so the agent (steered by whoever chats) and
 * the previewed app itself can write it. It therefore never gets to choose
 * anything outside its own sandbox:
 *  - every project: a backend's Dockerfile, build context and watch dir must
 *    resolve INSIDE the project (symlinks resolved) — a context like "../.."
 *    would send Claudable's data directory (other projects, the database) to the
 *    image build;
 *  - customer projects additionally: no custom container image (the default
 *    image only) and resources capped, so one tenant cannot exhaust the host.
 */
import path from 'path';
import { realPathInside } from '@/lib/utils/safe-fs';
import type { PreviewConfig } from './config';

const CUSTOMER_FRONTEND = { memoryBytes: 2 * 1024 ** 3, memory: '2g', cpus: 2 };
const CUSTOMER_BACKEND = { memoryBytes: 1024 ** 3, memory: '1g', cpus: 1, pids: 256 };

/** Docker memory string ("512m", "2g", "1073741824") → bytes; NaN when unparseable. */
function memoryBytes(value: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?)b?\s*$/i.exec(value);
  if (!m) return NaN;
  const unit = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as '' | 'k' | 'm' | 'g'];
  return Number(m[1]) * unit;
}

function capMemory(value: string | undefined, max: { memoryBytes: number; memory: string }): string {
  if (!value) return max.memory;
  const bytes = memoryBytes(value);
  return Number.isFinite(bytes) && bytes > 0 && bytes <= max.memoryBytes ? value : max.memory;
}

function capCpus(value: string | undefined, max: number): string {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= max ? String(value) : String(max);
}

async function insideProject(projectPath: string, rel: string | undefined): Promise<boolean> {
  if (rel === undefined) return true;
  if (typeof rel !== 'string' || path.isAbsolute(rel)) return false;
  return (await realPathInside(projectPath, path.resolve(projectPath, rel))) !== null;
}

export interface PolicyResult {
  cfg: PreviewConfig | null;
  /** Human-readable reasons for anything that was dropped or capped. */
  notes: string[];
}

export async function enforcePreviewConfigPolicy(
  input: PreviewConfig | null,
  projectPath: string,
  opts: { customer: boolean },
): Promise<PolicyResult> {
  if (!input) return { cfg: input, notes: [] };
  const notes: string[] = [];
  let cfg: PreviewConfig = { ...input };

  const c = cfg.backend?.container;
  if (c) {
    const ok =
      (await insideProject(projectPath, c.dockerfile)) &&
      (await insideProject(projectPath, c.context ?? '.')) &&
      (!c.dev || (await insideProject(projectPath, c.watchDir ?? 'backend')));
    if (!ok) {
      const { backend: _dropped, ...rest } = cfg;
      cfg = rest;
      notes.push('backend ignored: its Dockerfile, build context or watch dir points outside the project');
    }
  }

  if (!opts.customer) return { cfg, notes };

  if (cfg.frontend) {
    const { image, ...frontend } = cfg.frontend;
    if (image) notes.push('custom frontend image ignored (customer projects use the default image)');
    cfg = {
      ...cfg,
      frontend: {
        ...frontend,
        memory: capMemory(frontend.memory, CUSTOMER_FRONTEND),
        cpus: capCpus(frontend.cpus, CUSTOMER_FRONTEND.cpus),
      },
    };
  }
  const bc = cfg.backend?.container;
  if (cfg.backend && bc) {
    const pids = Number(bc.pidsLimit);
    cfg = {
      ...cfg,
      backend: {
        ...cfg.backend,
        container: {
          ...bc,
          memory: capMemory(bc.memory, CUSTOMER_BACKEND),
          cpus: capCpus(bc.cpus, CUSTOMER_BACKEND.cpus),
          pidsLimit: Number.isInteger(pids) && pids > 0 && pids <= CUSTOMER_BACKEND.pids ? pids : CUSTOMER_BACKEND.pids,
        },
      },
    };
  }
  return { cfg, notes };
}
