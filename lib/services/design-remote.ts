/**
 * Remote Claude Design access — list a user's claude.ai/design projects and
 * build the same "Project archive .zip" the browser Export produces, so a
 * project can be imported by picking it (no manual download+upload).
 *
 * claude.ai/design has no single "export zip" endpoint: the browser assembles
 * the archive from three cookie-authed JSON RPCs on the Omelette service:
 *   - ListProjects  {}                    -> { items: [{ projectId, name, ... }] }
 *   - ListFiles     { projectId, limit }  -> { entries: [{ path, type, ... }], total }
 *   - GetFile       { projectId, path }   -> { content(base64), contentType, version }
 * We replicate that server-side and re-zip, then feed the existing import
 * pipeline (lib/services/design-import).
 *
 * SECURITY / SCOPE: this needs the claude.ai session cookie (`sessionKey`), a
 * FULL-ACCOUNT credential, and depends on an undocumented API behind Cloudflare
 * that Anthropic can change at any time. It is therefore ADMIN-ONLY and OFF by
 * default: enabled solely when the `CLAUDE_AI_SESSION_KEY` env var is set. The
 * key is never entered through the UI and never stored in the database.
 */
import { zipSync, type Zippable } from 'fflate';
import { shouldKeep } from '@/lib/utils/design-keep';

const RPC_BASE = 'https://claude.ai/design/anthropic.omelette.api.v1alpha.OmeletteService';
// Cap the archive so a runaway project can't exhaust server memory. We only
// fetch the design files we keep (screens/fonts/assets), not screenshots/uploads,
// so the real footprint is far smaller than a raw export.
const MAX_FILES = 400;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024; // 150 MB of KEPT files

export interface RemoteDesignProject {
  id: string;
  name: string;
  updatedAt: string | null;
  ownerName: string | null;
}

/** Whether remote Claude Design access is configured (admin opt-in via env). */
export function designRemoteEnabled(): boolean {
  return !!process.env.CLAUDE_AI_SESSION_KEY;
}

function sessionKey(): string {
  const key = process.env.CLAUDE_AI_SESSION_KEY;
  if (!key) throw new Error('Remote Claude Design is not configured (CLAUDE_AI_SESSION_KEY unset).');
  return key;
}

/** One cookie-authed JSON RPC against the Omelette service. */
async function rpc<T>(method: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${RPC_BASE}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Mimic the browser so Cloudflare is less likely to challenge the call.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        'Origin': 'https://claude.ai',
        'Referer': 'https://claude.ai/design',
        Cookie: `sessionKey=${sessionKey()}`,
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (e) {
    throw new Error(`Could not reach claude.ai: ${e instanceof Error ? e.message : 'network error'}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('claude.ai rejected the session key (expired or blocked). Update CLAUDE_AI_SESSION_KEY.');
  }
  if (!res.ok) {
    throw new Error(`claude.ai ${method} failed (HTTP ${res.status}).`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    // A Cloudflare interstitial returns HTML, not JSON.
    throw new Error('Unexpected response from claude.ai (possibly a Cloudflare challenge).');
  }
}

interface ListProjectsResp {
  items?: Array<{ projectId: string; name?: string; viewedAt?: string; updatedAt?: string; ownerDisplayName?: string }>;
}
interface ListFilesResp {
  entries?: Array<{ path?: string; name?: string; type?: string; size?: string }>;
  total?: number;
}
interface GetFileResp {
  content?: string; // base64
  contentType?: string;
}

/** List the Design projects visible to the configured account (most-recent first). */
export async function listRemoteDesignProjects(): Promise<RemoteDesignProject[]> {
  const data = await rpc<ListProjectsResp>('ListProjects', {});
  const items = data.items ?? [];
  return items
    .filter((p) => p.projectId)
    .map((p) => ({
      id: p.projectId,
      name: p.name || 'Untitled design',
      updatedAt: p.viewedAt ?? p.updatedAt ?? null,
      ownerName: p.ownerDisplayName ?? null,
    }))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

/**
 * Build the project-archive zip (every file in the design project) as the same
 * bytes the browser Export → "Project archive .zip" produces, by listing files
 * and reading each one. Throws with a user-facing message on any failure.
 */
export async function buildRemoteDesignArchive(designProjectId: string): Promise<Uint8Array> {
  if (!/^[0-9a-f-]{16,64}$/i.test(designProjectId)) {
    throw new Error('Invalid design project id.');
  }
  const list = await rpc<ListFilesResp>('ListFiles', { projectId: designProjectId, limit: MAX_FILES + 1 });
  const files = (list.entries ?? []).filter((e) => e.type === 'file' && e.path);
  if (files.length === 0) {
    throw new Error('That design project has no files to import.');
  }
  if (files.length > MAX_FILES) {
    throw new Error(`Design project has too many files (${files.length}; limit ${MAX_FILES}).`);
  }

  const out: Zippable = {};
  let totalBytes = 0;
  for (const f of files) {
    const path = f.path as string;
    // Path-safety: the entry becomes a zip path that extractDesignImport writes
    // out; reject traversal here as a first line of defence (the extractor also
    // contains writes to design-reference/).
    if (path.includes('..') || path.startsWith('/')) continue;
    // Only fetch the files the importer keeps (screens/fonts/assets). Skipping
    // design-process noise (screenshots, raw uploads) here avoids downloading and
    // buffering hundreds of MB the extractor would just drop.
    if (!shouldKeep(path)) continue;
    const gf = await rpc<GetFileResp>('GetFile', { projectId: designProjectId, path });
    if (typeof gf.content !== 'string') continue;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(gf.content, 'base64');
    } catch {
      continue; // skip an undecodable file rather than fail the whole import
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`Design project is too large (> ${MAX_TOTAL_BYTES / 1024 / 1024} MB).`);
    }
    out[path] = new Uint8Array(bytes);
  }

  if (Object.keys(out).length === 0) {
    throw new Error('Could not read any files from that design project.');
  }
  return zipSync(out);
}
