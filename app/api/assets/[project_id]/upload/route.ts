import { NextResponse } from 'next/server';
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

function resolveAssetsPath(projectId: string): string {
  return path.join(PROJECTS_DIR_ABSOLUTE, projectId, 'assets');
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 500 * 1024 * 1024);
    const contentType = request.headers.get('content-type') || '';

    // Two upload modes:
    //  - multipart/form-data: small files from existing callers (project create, …).
    //  - raw body (any other content-type): large files (zips/archives) sent as the
    //    raw request body so we stream to disk and never hit undici's FormData parse
    //    limit. The client passes ?filename= & ?type= in the query string.
    let originalName: string;
    let declaredType: string;
    let bodyStream: Readable;

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json({ success: false, error: 'File field is required' }, { status: 400 });
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { success: false, error: `File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)` },
          { status: 413 },
        );
      }
      originalName = file.name || 'file';
      declaredType = file.type || '';
      bodyStream = Readable.fromWeb(file.stream() as any);
    } else {
      const url = new URL(request.url);
      originalName = url.searchParams.get('filename') || 'file';
      declaredType = url.searchParams.get('type') || contentType || '';
      const declaredLen = Number(request.headers.get('content-length') || 0);
      if (declaredLen && declaredLen > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { success: false, error: `File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)` },
          { status: 413 },
        );
      }
      if (!request.body) {
        return NextResponse.json({ success: false, error: 'Empty request body' }, { status: 400 });
      }
      bodyStream = Readable.fromWeb(request.body as any);
    }

    const projectAssetsPath = resolveAssetsPath(project_id);
    await fs.mkdir(projectAssetsPath, { recursive: true });

    // The stored name is a random UUID, so the original name/extension can never
    // cause path traversal. Only the extension is carried over.
    const extension = path.extname(originalName); // '' when the file has no extension
    const uniqueName = `${randomUUID()}${extension}`;
    const absolutePath = path.join(projectAssetsPath, uniqueName);
    const resolvedAbsolutePath = path.resolve(absolutePath);

    // Stream straight to disk (no full-file buffering) — matters for large zips.
    await pipeline(bodyStream, createWriteStream(resolvedAbsolutePath));

    // Enforce the cap for raw-body uploads that lied about / omitted content-length.
    const written = (await fs.stat(resolvedAbsolutePath)).size;
    if (written > MAX_UPLOAD_BYTES) {
      await fs.unlink(resolvedAbsolutePath).catch(() => {});
      return NextResponse.json(
        { success: false, error: `File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)` },
        { status: 413 },
      );
    }

    // Only images need a web-served copy (preview/<img>). Archives, zips, docs etc.
    // are read by the agent from the project on disk, so skip the extra mirror
    // copies for them — no point duplicating a large zip into public/uploads.
    const isImage = (declaredType || '').startsWith('image/');
    let hostPublicPath: string | null = null;
    let projectPublicPath: string | null = null;
    let publicUrl: string | null = null;
    if (isImage) try {
      const rootUploadsDir = path.join(process.cwd(), 'public', 'uploads');
      await fs.mkdir(rootUploadsDir, { recursive: true });
      const hostDestination = path.join(rootUploadsDir, uniqueName);
      try {
        await fs.access(hostDestination);
      } catch {
        await fs.copyFile(resolvedAbsolutePath, hostDestination);
      }
      hostPublicPath = hostDestination;
      publicUrl = `/uploads/${uniqueName}`;
    } catch (copyError) {
      console.warn('[Assets Upload] Failed to mirror asset into application public/uploads:', copyError);
    }

    if (isImage) try {
      const projectRoot = project.repoPath
        ? (path.isAbsolute(project.repoPath) ? project.repoPath : path.resolve(process.cwd(), project.repoPath))
        : path.join(PROJECTS_DIR_ABSOLUTE, project_id);
      const uploadsDir = path.join(projectRoot, 'public', 'uploads');
      await fs.mkdir(uploadsDir, { recursive: true });
      projectPublicPath = path.join(uploadsDir, uniqueName);
      try {
        await fs.access(projectPublicPath);
      } catch {
        await fs.copyFile(resolvedAbsolutePath, projectPublicPath);
      }
    } catch (copyError) {
      console.warn('[Assets Upload] Failed to mirror asset into project public/uploads:', copyError);
      projectPublicPath = null;
      if (!hostPublicPath) {
        publicUrl = null;
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
