/**
 * GET /api/projects/[project_id]/design-explorer/frames/[frame_id]/html
 * Serve a frame's rendered mockup HTML as text/plain (the board injects it into
 * a sandboxed <iframe srcdoc>). Not text/html — we never want the browser to
 * treat it as a same-origin document.
 */
import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { prisma } from '@/lib/db/client';

interface RouteContext { params: Promise<{ project_id: string; frame_id: string }>; }

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id, frame_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id);
    if (_gate) return _gate;

    const frame = await prisma.designFrame.findUnique({
      where: { id: frame_id },
      include: { canvas: { select: { projectId: true } } },
    });
    if (!frame || frame.canvas.projectId !== project_id || !frame.htmlPath) {
      return NextResponse.json({ success: false, error: 'No design HTML' }, { status: 404 });
    }
    const html = await fs.readFile(frame.htmlPath, 'utf8').catch(() => null);
    if (html === null) return NextResponse.json({ success: false, error: 'HTML missing on disk' }, { status: 404 });

    return new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=60' },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Failed to read design HTML' }, { status: 500 });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
