import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getProjectById } from '@/lib/services/project';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(process.cwd(), PROJECTS_DIR);

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const b64 = typeof body?.b64_png === 'string' ? body.b64_png : null;
    if (!b64) {
      return NextResponse.json({ success: false, error: 'b64_png is required' }, { status: 400 });
    }
    // Cap the payload (~6MB base64 ≈ 4.5MB binary) to avoid memory/disk abuse.
    if (b64.length > 6 * 1024 * 1024) {
      return NextResponse.json({ success: false, error: 'Logo too large (max ~4.5MB)' }, { status: 413 });
    }

    const buffer = Buffer.from(b64, 'base64');
    const assetsPath = path.join(PROJECTS_DIR_ABSOLUTE, project_id, 'assets');
    await fs.mkdir(assetsPath, { recursive: true });
    const logoPath = path.join(assetsPath, 'logo.png');
    await fs.writeFile(logoPath, buffer);

    return NextResponse.json({ success: true, path: 'assets/logo.png' });
  } catch (error) {
    console.error('[Assets Logo] Failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to save logo',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
