/**
 * POST /api/projects/[id]/design-import/remote  { sourceProjectId }
 * Imports a claude.ai/design project directly (no manual zip): builds the same
 * project archive server-side from the design project's files, stages it into
 * `design-reference/`, and returns the same manifest + prompt as the upload path.
 * Gated on the admin opt-in (CLAUDE_AI_SESSION_KEY); see lib/services/design-remote.
 */
import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getProjectById } from '@/lib/services/project';
import { extractDesignImport, buildPortPrompt } from '@/lib/services/design-import';
import { designRemoteEnabled, buildRemoteDesignArchive } from '@/lib/services/design-remote';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const gate = await denyUnlessProjectAccess(project_id, { write: true });
    if (gate) return gate;

    if (!designRemoteEnabled()) {
      return NextResponse.json(
        { success: false, error: 'Remote Claude Design import is not configured on this server.' },
        { status: 400 }
      );
    }

    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }
    if (!project.repoPath) {
      return NextResponse.json({ success: false, error: 'Project has no workspace directory' }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as { sourceProjectId?: unknown };
    const sourceProjectId = typeof body.sourceProjectId === 'string' ? body.sourceProjectId.trim() : '';
    if (!sourceProjectId) {
      return NextResponse.json({ success: false, error: 'sourceProjectId is required' }, { status: 400 });
    }

    let zip: Uint8Array;
    try {
      zip = await buildRemoteDesignArchive(sourceProjectId);
    } catch (error) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : 'Failed to fetch the design project' },
        { status: 502 }
      );
    }

    let manifest;
    try {
      manifest = await extractDesignImport(zip, project.repoPath);
    } catch (error) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : 'Failed to extract the design export' },
        { status: 422 }
      );
    }

    return NextResponse.json({
      success: true,
      data: { manifest, suggestedPrompt: buildPortPrompt(manifest) },
    });
  } catch (error) {
    console.error('[API] remote design-import failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Design import failed' },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
