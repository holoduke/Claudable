/**
 * POST /api/projects/[id]/design-import
 * Imports a Claude Design (claude.ai/design) zip export: stages the useful
 * design files into the project's `design-reference/` folder and returns a
 * manifest plus a ready-to-edit instruction the user can send to the agent.
 *
 * Two ways in:
 *  - JSON `{ uploadPath: "assets/<uuid>.zip" }` — the zip was sent first through
 *    the CHUNKED asset upload (/api/assets/:id/upload). This is what the UI uses:
 *    the proxies cap one request body at ~10MB, so a large export can't be posted
 *    in one go. The staged zip is removed after the import.
 *  - multipart form-data (field `file`) — kept for small zips / API callers.
 *
 * Errors carry a `code` (not_zip, too_large, not_design_export, unreadable,
 * invalid_upload, upload_missing) the UI translates, plus an English `error`.
 */

import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getProjectById } from '@/lib/services/project';
import {
  DesignImportError,
  MAX_DESIGN_UPLOAD_BYTES,
  buildPortPrompt,
  extractDesignImport,
  readStagedDesignUpload,
  tooLargeError,
} from '@/lib/services/design-import';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(/* turbopackIgnore: true */ process.cwd(), PROJECTS_DIR);

function fail(code: string, error: string, status: number, params?: Record<string, number>) {
  return NextResponse.json({ success: false, code, error, ...(params ? { params } : {}) }, { status });
}

function failFrom(error: DesignImportError) {
  const status = error.code === 'too_large' ? 413 : error.code === 'invalid_upload' ? 400 : error.code === 'upload_missing' ? 404 : 422;
  return fail(error.code, error.message, status, error.params);
}

/** The zip bytes from a multipart body (legacy / small uploads). */
async function readMultipartZip(request: Request): Promise<Uint8Array | NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail('invalid_body', 'Expected JSON { uploadPath } or multipart form-data with a "file" field', 400);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('invalid_body', 'No file uploaded (field "file")', 400);
  const blob = file as File;
  const name = (blob.name || '').toLowerCase();
  const isZip = name.endsWith('.zip') || blob.type === 'application/zip' || blob.type === 'application/x-zip-compressed';
  if (!isZip) return fail('not_zip', 'Please upload a .zip export from Claude Design', 400);
  if (blob.size > MAX_DESIGN_UPLOAD_BYTES) return failFrom(tooLargeError(blob.size));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function POST(request: Request, { params }: RouteContext) {
  let stagedPath: string | null = null;
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id, { write: true, fullEdit: true });
    if (_gate) return _gate;

    const project = await getProjectById(project_id);
    if (!project) return fail('not_found', 'Project not found', 404);
    if (!project.repoPath) return fail('no_workspace', 'Project has no workspace directory', 400);

    let bytes: Uint8Array;
    if ((request.headers.get('content-type') || '').includes('application/json')) {
      const body = (await request.json().catch(() => null)) as { uploadPath?: unknown } | null;
      const staged = await readStagedDesignUpload(path.join(PROJECTS_DIR_ABSOLUTE, project_id), body?.uploadPath);
      stagedPath = staged.absolutePath;
      bytes = staged.bytes;
    } else {
      const read = await readMultipartZip(request);
      if (read instanceof NextResponse) return read;
      bytes = read;
    }

    const manifest = await extractDesignImport(bytes, project.repoPath);
    return NextResponse.json({
      success: true,
      data: { manifest, suggestedPrompt: buildPortPrompt(manifest) },
    });
  } catch (error) {
    if (error instanceof DesignImportError) return failFrom(error);
    console.error('[API] design-import failed:', error);
    return fail('import_failed', error instanceof Error ? error.message : 'Design import failed', 500);
  } finally {
    // The chunk-uploaded zip was only a carrier: the kept subset now lives in design-reference/.
    if (stagedPath) await fs.rm(stagedPath, { force: true }).catch(() => {});
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
