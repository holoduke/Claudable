import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getProjectById } from '@/lib/services/project';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(process.cwd(), PROJECTS_DIR);

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 500 * 1024 * 1024);
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

function resolveAssetsPath(projectId: string): string {
  return path.join(PROJECTS_DIR_ABSOLUTE, projectId, 'assets');
}

const STALE_PART_MS = 6 * 60 * 60 * 1000; // 6h

/** Delete .part files older than STALE_PART_MS (abandoned chunked uploads). */
async function sweepStaleParts(tmpDir: string): Promise<void> {
  const now = Date.now();
  const files = await fs.readdir(tmpDir).catch(() => [] as string[]);
  await Promise.all(
    files
      .filter((f) => f.endsWith('.part'))
      .map(async (f) => {
        const p = path.join(tmpDir, f);
        const st = await fs.stat(p).catch(() => null);
        if (st && now - st.mtimeMs > STALE_PART_MS) await fs.unlink(p).catch(() => {});
      }),
  );
}

function tooLarge(): NextResponse {
  return NextResponse.json(
    { success: false, error: `File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)` },
    { status: 413 },
  );
}

/**
 * Finalize a stored asset: only IMAGES get mirrored into public/uploads (they're
 * referenced by <img>); zips/docs/etc. are read by the agent from disk, so we skip
 * the extra (potentially large) copies. Returns the API response.
 */
async function finalizeAsset(
  project: { repoPath?: string | null },
  projectId: string,
  resolvedAbsolutePath: string,
  uniqueName: string,
  originalName: string,
  declaredType: string,
): Promise<NextResponse> {
  const isImage = (declaredType || '').startsWith('image/');
  let hostPublicPath: string | null = null;
  let projectPublicPath: string | null = null;
  let publicUrl: string | null = null;

  if (isImage) {
    try {
      const rootUploadsDir = path.join(process.cwd(), 'public', 'uploads');
      await fs.mkdir(rootUploadsDir, { recursive: true });
      const hostDestination = path.join(rootUploadsDir, uniqueName);
      try { await fs.access(hostDestination); } catch { await fs.copyFile(resolvedAbsolutePath, hostDestination); }
      hostPublicPath = hostDestination;
      publicUrl = `/uploads/${uniqueName}`;
    } catch (e) {
      console.warn('[Assets Upload] Failed to mirror into application public/uploads:', e);
    }
    try {
      const projectRoot = project.repoPath
        ? (path.isAbsolute(project.repoPath) ? project.repoPath : path.resolve(process.cwd(), project.repoPath))
        : path.join(PROJECTS_DIR_ABSOLUTE, projectId);
      const uploadsDir = path.join(projectRoot, 'public', 'uploads');
      await fs.mkdir(uploadsDir, { recursive: true });
      projectPublicPath = path.join(uploadsDir, uniqueName);
      try { await fs.access(projectPublicPath); } catch { await fs.copyFile(resolvedAbsolutePath, projectPublicPath); }
    } catch (e) {
      console.warn('[Assets Upload] Failed to mirror into project public/uploads:', e);
      projectPublicPath = null;
      if (!hostPublicPath) publicUrl = null;
    }
  }

  return NextResponse.json({
    success: true,
    path: `assets/${uniqueName}`,
    absolute_path: resolvedAbsolutePath,
    filename: uniqueName,
    original_filename: originalName,
    public_path: hostPublicPath ?? projectPublicPath,
    public_url: publicUrl,
  });
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (_gate) return _gate;
    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    const contentType = request.headers.get('content-type') || '';
    const url = new URL(request.url);
    const chunkCount = Number(url.searchParams.get('chunks') || 0);

    const projectAssetsPath = resolveAssetsPath(project_id);
    await fs.mkdir(projectAssetsPath, { recursive: true });

    // ---- Chunked raw-body upload (the only path that handles large files) -------
    // The client slices the file into sub-limit chunks (proxies & the Next server
    // cap a single request body at ~10MB) and posts them in order, keyed by a
    // per-upload uuid. Chunks are appended to a .part file; the last one finalizes.
    if (chunkCount > 0) {
      const uploadId = url.searchParams.get('uploadId') || '';
      const chunkIndex = Number(url.searchParams.get('chunkIndex') || -1);
      const originalName = url.searchParams.get('filename') || 'file';
      const declaredType = url.searchParams.get('type') || '';
      if (!UUID_RE.test(uploadId)) {
        return NextResponse.json({ success: false, error: 'Invalid uploadId' }, { status: 400 });
      }
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount) {
        return NextResponse.json({ success: false, error: 'Invalid chunkIndex' }, { status: 400 });
      }
      if (!request.body) {
        return NextResponse.json({ success: false, error: 'Empty chunk body' }, { status: 400 });
      }

      const tmpDir = path.join(projectAssetsPath, '.uploads');
      await fs.mkdir(tmpDir, { recursive: true });
      const partPath = path.join(tmpDir, `${uploadId}.part`);

      // Best-effort sweep of abandoned .part files (a failed mid-sequence upload
      // leaves one behind). Runs on chunk 0 so it can't fill the disk over time.
      if (chunkIndex === 0) {
        await sweepStaleParts(tmpDir).catch(() => {});
      }

      // First chunk truncates; later chunks append (client sends them in order).
      await pipeline(
        Readable.fromWeb(request.body as any),
        createWriteStream(partPath, { flags: chunkIndex === 0 ? 'w' : 'a' }),
      );

      const soFar = (await fs.stat(partPath)).size;
      if (soFar > MAX_UPLOAD_BYTES) {
        await fs.unlink(partPath).catch(() => {});
        return tooLarge();
      }

      if (chunkIndex < chunkCount - 1) {
        return NextResponse.json({ success: true, received: chunkIndex });
      }

      // Last chunk → promote the .part file to its final UUID name.
      const extension = path.extname(originalName);
      const uniqueName = `${randomUUID()}${extension}`;
      const resolvedAbsolutePath = path.resolve(path.join(projectAssetsPath, uniqueName));
      await fs.rename(partPath, resolvedAbsolutePath);
      return finalizeAsset(project, project_id, resolvedAbsolutePath, uniqueName, originalName, declaredType);
    }

    // ---- Single-shot small uploads (existing callers) ---------------------------
    let originalName: string;
    let declaredType: string;
    let bodyStream: Readable;

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json({ success: false, error: 'File field is required' }, { status: 400 });
      }
      if (file.size > MAX_UPLOAD_BYTES) return tooLarge();
      originalName = file.name || 'file';
      declaredType = file.type || '';
      bodyStream = Readable.fromWeb(file.stream() as any);
    } else {
      originalName = url.searchParams.get('filename') || 'file';
      declaredType = url.searchParams.get('type') || contentType || '';
      const declaredLen = Number(request.headers.get('content-length') || 0);
      if (declaredLen && declaredLen > MAX_UPLOAD_BYTES) return tooLarge();
      if (!request.body) {
        return NextResponse.json({ success: false, error: 'Empty request body' }, { status: 400 });
      }
      bodyStream = Readable.fromWeb(request.body as any);
    }

    const extension = path.extname(originalName);
    const uniqueName = `${randomUUID()}${extension}`;
    const resolvedAbsolutePath = path.resolve(path.join(projectAssetsPath, uniqueName));
    await pipeline(bodyStream, createWriteStream(resolvedAbsolutePath));

    const written = (await fs.stat(resolvedAbsolutePath)).size;
    if (written > MAX_UPLOAD_BYTES) {
      await fs.unlink(resolvedAbsolutePath).catch(() => {});
      return tooLarge();
    }

    return finalizeAsset(project, project_id, resolvedAbsolutePath, uniqueName, originalName, declaredType);
  } catch (error) {
    console.error('[Assets Upload] Failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to upload file',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
