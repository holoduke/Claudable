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

    const formData = await request.formData();
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: 'File field is required' }, { status: 400 });
    }

    // Accept any file type (documents, archives, data, images…). Guard only on
    // size so an upload can't exhaust disk. The stored name is a random UUID, so
    // the original name/extension can never cause path traversal.
    const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 500 * 1024 * 1024);
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { success: false, error: `File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)` },
        { status: 413 },
      );
    }

    const projectAssetsPath = resolveAssetsPath(project_id);
    await fs.mkdir(projectAssetsPath, { recursive: true });

    const originalName = file.name || 'file';
    const extension = path.extname(originalName); // '' when the file has no extension
    const uniqueName = `${randomUUID()}${extension}`;
    const absolutePath = path.join(projectAssetsPath, uniqueName);
    const resolvedAbsolutePath = path.resolve(absolutePath);

    // Stream the body to disk instead of buffering the whole file in memory a
    // second time via arrayBuffer() — matters for large uploads (zips, archives).
    await pipeline(Readable.fromWeb(file.stream() as any), createWriteStream(resolvedAbsolutePath));

    // Only images need a web-served copy (preview/<img>). Archives, zips, docs etc.
    // are read by the agent from the project on disk, so skip the extra mirror
    // copies for them — no point duplicating a large zip into public/uploads.
    const isImage = (file.type || '').startsWith('image/');
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
