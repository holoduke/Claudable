/**
 * POST /api/projects/[id]/design-import
 * Accepts a Claude Design (claude.ai/design) zip export as multipart form-data
 * (field `file`), stages the useful design files into the project's
 * `design-reference/` folder, and returns a manifest plus a ready-to-edit
 * instruction the user can send to the agent to port the design.
 */

import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getProjectById } from '@/lib/services/project';
import { extractDesignImport, buildPortPrompt } from '@/lib/services/design-import';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

// Claude Design exports can be large (assets + fonts), but we only keep a small
// subset. Cap the upload to protect the server from absurd payloads.
const MAX_UPLOAD_BYTES = 600 * 1024 * 1024; // 600 MB

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id);
    if (_gate) return _gate;

    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }
    if (!project.repoPath) {
      return NextResponse.json(
        { success: false, error: 'Project has no workspace directory' },
        { status: 400 }
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Expected multipart form-data with a "file" field' },
        { status: 400 }
      );
    }

    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return NextResponse.json(
        { success: false, error: 'No file uploaded (field "file")' },
        { status: 400 }
      );
    }

    const blob = file as File;
    const name = (blob.name || '').toLowerCase();
    const isZip =
      name.endsWith('.zip') ||
      blob.type === 'application/zip' ||
      blob.type === 'application/x-zip-compressed';
    if (!isZip) {
      return NextResponse.json(
        { success: false, error: 'Please upload a .zip export from Claude Design' },
        { status: 400 }
      );
    }
    if (blob.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          success: false,
          error: `Zip is too large (${(blob.size / 1024 / 1024).toFixed(0)} MB). Limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
        },
        { status: 413 }
      );
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());

    let manifest;
    try {
      manifest = await extractDesignImport(bytes, project.repoPath);
    } catch (error) {
      return NextResponse.json(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to extract the design export',
        },
        { status: 422 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        manifest,
        suggestedPrompt: buildPortPrompt(manifest),
      },
    });
  } catch (error) {
    console.error('[API] design-import failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Design import failed',
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Allow large multipart bodies (the kept subset is small, but the raw zip can be big).
export const maxDuration = 120;
