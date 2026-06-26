/**
 * GET /api/projects/[id]/preview/status
 * Returns the current preview status for the project.
 */

import { NextResponse } from 'next/server';
import { previewManager } from '@/lib/services/preview';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(
  _request: Request,
  { params }: RouteContext
) {
  try {
    const { project_id } = await params;
    const preview = previewManager.getStatus(project_id);

    const res = NextResponse.json({
      success: true,
      data: preview,
    });
    // Status is live and changes constantly; never let the browser cache it
    // (a stale 'starting'/'stopped' makes the UI cold-start an already-running
    // preview).
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (error) {
    console.error('[API] Failed to fetch preview status:', error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to fetch preview status',
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
