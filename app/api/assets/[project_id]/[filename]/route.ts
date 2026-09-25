import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import fs from 'fs/promises';
import path from 'path';
import { getProjectById } from '@/lib/services/project';
import { readFileInside } from '@/lib/utils/safe-fs';

interface RouteContext {
  params: Promise<{ project_id: string; filename: string }>;
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(process.cwd(), PROJECTS_DIR);

function inferContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { project_id, filename } = await params;
  const _gate = await denyUnlessProjectAccess(project_id);
  if (_gate) return _gate;

  try {

    console.log('📸 Asset serving request:', {
      project_id,
      filename,
      projectsDir: PROJECTS_DIR,
      userAgent: _request.headers.get('user-agent')
    });

    const project = await getProjectById(project_id);
    if (!project) {
      console.log('📸 Asset serving failed: Project not found:', project_id);
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    // Path-traversal guard: `filename` is URL-decoded by Next, so a value like
    // "..%2F..%2Fcc.db" would otherwise escape the assets dir and read arbitrary
    // files. Reject separators, then resolve + prefix-check the final path.
    const assetsDir = path.join(PROJECTS_DIR_ABSOLUTE, project_id, 'assets');
    const filePath = path.resolve(assetsDir, filename);
    if (/[\\/]/.test(filename) || filename.includes('..') || (filePath !== assetsDir && !filePath.startsWith(assetsDir + path.sep))) {
      return NextResponse.json({ success: false, error: 'Invalid filename' }, { status: 400 });
    }
    // Symlink-safe read: the assets dir is agent-writable, so a symlink here must
    // never resolve outside the project (e.g. /proc/self/environ, the database).
    const projectRoot = path.join(PROJECTS_DIR_ABSOLUTE, project_id);
    const fileBuffer = await readFileInside(projectRoot, filePath);
    if (!fileBuffer) {
      return NextResponse.json({ success: false, error: 'Image not found' }, { status: 404 });
    }

    const response = new NextResponse(fileBuffer as unknown as BodyInit);
    response.headers.set('Content-Type', inferContentType(filename));
    response.headers.set('X-Content-Type-Options', 'nosniff');
    // Assets are project content behind the auth gate: never cache them in shared caches.
    response.headers.set('Cache-Control', 'private, max-age=3600');
    if (/\.svg$/i.test(filename)) {
      // An SVG can carry script; served from the Claudable origin it would run
      // with the viewer's session. Sandbox it and make it a download.
      response.headers.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      response.headers.set('Content-Disposition', 'attachment');
    }

    return response;
  } catch (error) {
    console.error('[Assets Get] Failed:', error);
    console.error('[Assets Get] Error details:', {
      project_id,
      filename,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to load image',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
